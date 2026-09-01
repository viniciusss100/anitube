'use strict';

/**
 * Extrator de streams — v4.1.0
 * Melhorias:
 *  - Agents keepAlive reutilizados
 *  - safeFetch com timeout + retry
 *  - Decodificação robusta de HLS vars (base64/encodeURIComponent)
 *  - Blogger parser tolerante a variações de batchexecute
 *  - Paralelização de extractStreams com Promise.allSettled
 *  - PUBLIC_URL placeholder injetado corretamente
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const config = require('./config');
const logger = require('./logger');

const log = logger.child('extractor');

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent': UA_MOBILE,
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
function getAgent(url) {
  try { return new URL(url).protocol === 'http:' ? httpAgent : httpsAgent; } catch (_) { return httpsAgent; }
}

const ITAG_QUALITY = { 37: 1080, 22: 720, 59: 480, 18: 360 };
const MIN_STREAM_QUALITY = 480;
const QUALITY_LABEL = { 1080: 'FHD 1080p', 720: 'HD 720p', 480: 'SD 480p', 360: 'SD 360p' };

const PUBLIC_URL = '{{PUBLIC_URL}}';

// ───────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ───────────────────────────────────────────────────────────────────────────

async function safeFetch(url, opts = {}, timeout = 12000, retries = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, agent: getAgent(url), signal: ctrl.signal });
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = attempt * 400 + Math.floor(Math.random() * 200);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function extractHLSFromVideoHLS(src) {
  try {
    const u = new URL(src.startsWith('//') ? 'https:' + src : src);
    // params: d, url, file
    const candidates = ['d', 'url', 'file', 'src'];
    for (const k of candidates) {
      const v = u.searchParams.get(k);
      if (v && v.startsWith('http')) {
        // Pode estar encoded 1x ou 2x, ou base64
        let decoded = v;
        try { decoded = decodeURIComponent(decoded); } catch (_) {}
        try { decoded = decodeURIComponent(decoded); } catch (_) {}
        // tenta base64 se parecer
        if (!decoded.startsWith('http') && /^[A-Za-z0-9+/=]{20,}$/.test(decoded)) {
          try {
            const b64 = Buffer.from(decoded, 'base64').toString('utf8');
            if (b64.startsWith('http')) decoded = b64;
          } catch (_) {}
        }
        if (decoded.startsWith('http')) return decoded;
      }
    }
    // fallback regex
    const m = src.match(/[?&](?:d|url|file)=([^&]+)/);
    if (m) {
      let d = m[1];
      try { d = decodeURIComponent(d); } catch (_) {}
      try { d = decodeURIComponent(d); } catch (_) {}
      if (d.startsWith('http')) return d;
    }
  } catch (_) {
    const m = src.match(/[?&]d=([^&]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
    }
  }
  return null;
}

function extractBloggerToken(url) {
  try {
    const u = new URL(url);
    const t = u.searchParams.get('token');
    if (t) return decodeURIComponent(t);
  } catch (_) {}
  const m = url.match(/[?&]token=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function decodeGoogleVideoUrl(raw) {
  let url = raw;
  for (let i = 0; i < 4; i++) {
    url = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    url = url.replace(/\\\//g, '/');
    url = url.replace(/\\\\/g, '\\');
    url = url.replace(/\\=/g, '=');
    url = url.replace(/\\&/g, '&');
  }
  return url.replace(/^"+|"+$/g, '').trim();
}

function extractItagFromUrl(url) {
  const m = url.match(/[&?]itag[=%](\d+)/i) || url.match(/itag=(\d+)/);
  return m ? parseInt(m[1], 10) : 18;
}

function extractVideoId(url) {
  const m = url.match(/[?&]id=([a-f0-9]+)/);
  return m ? m[1] : 'picasacid';
}

function generateCpn(token, videoId, timestamp) {
  try {
    const seed = `boq_bloggeruiserver_20260317.01_p0${videoId}${timestamp}${token}`;
    const hash = crypto.createHash('sha256').update(seed).digest('base64');
    return hash.replace(/[+/=]/g, '').substring(0, 16);
  } catch (_) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// BLOGGER / GOOGLEVIDEO
// ───────────────────────────────────────────────────────────────────────────

function parseGoogleVideoUrls(responseText) {
  const videos = [];
  const cleaned = responseText.replace(/^\)\]}'[\s\n]*/, '');

  const wrbMatch = cleaned.match(/\[\s*\[\s*"wrb\.fr"\s*,[^,]+,\s*"([\s\S]+?)"\s*,\s*null/);
  let jsonStr = wrbMatch ? wrbMatch[1] : cleaned;

  // Desescapa
  jsonStr = jsonStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  jsonStr = jsonStr.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  const urlPattern = /"((?:https?:(?:\\\/|\/))[^"]*?googlevideo[^"]*?)",\[(\d+)\]/g;
  let m;
  while ((m = urlPattern.exec(jsonStr)) !== null) {
    const rawUrl = m[1];
    const itag = parseInt(m[2], 10);
    const decoded = decodeGoogleVideoUrl(rawUrl);
    if (decoded && decoded.includes('googlevideo.com')) {
      videos.push({ url: decoded, itag, quality: ITAG_QUALITY[itag] || 360 });
    }
  }

  if (videos.length === 0) {
    const fallback = /https?:[^\s"'<>]*googlevideo\.com[^\s"'<>\\]+/g;
    while ((m = fallback.exec(jsonStr)) !== null) {
      const decoded = decodeGoogleVideoUrl(m[0]);
      const itag = extractItagFromUrl(decoded);
      if (!videos.some(v => v.itag === itag)) {
        videos.push({ url: decoded, itag, quality: ITAG_QUALITY[itag] || 360 });
      }
    }
  }

  const seen = new Set();
  const unique = videos.filter(v => {
    if (seen.has(v.itag)) return false;
    seen.add(v.itag);
    return true;
  });

  const filtered = unique.filter(v => (v.quality || 0) >= MIN_STREAM_QUALITY);

  const order = [37, 22, 59];
  filtered.sort((a, b) => {
    const ia = order.indexOf(a.itag);
    const ib = order.indexOf(b.itag);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return filtered;
}

async function fetchBloggerStreams(token, referer) {
  const reqid = Math.floor(10000 + Math.random() * 89999);
  const bl = 'boq_bloggeruiserver_20260317.01_p0';
  const apiUrl = `https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?rpcids=WcwnYd&source-path=%2Fvideo.g&bl=${bl}&_reqid=${reqid}&rt=c`;
  const body = `f.req=[[[\"WcwnYd\",\"[\\\"${token}\\\"]\",null,\"generic\"]]]&`;

  try {
    const res = await safeFetch(apiUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA_MOBILE,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-same-domain': '1',
        Referer: referer || 'https://www.blogger.com/',
      },
      body,
    }, 10000, 1);
    if (!res.ok) {
      log.warn(`Blogger batchexecute ${res.status}`);
      return [];
    }
    const text = await res.text();
    return parseGoogleVideoUrls(text);
  } catch (e) {
    log.warn(`Blogger fetch erro: ${e.message}`);
    return [];
  }
}

function makeGoogleVideoStream(tabName, { url, itag, quality }) {
  const timestamp = Date.now();
  const videoId = extractVideoId(url);
  const cpn = generateCpn(videoId, videoId, timestamp);
  const sep = url.includes('?') ? '&' : '?';
  const finalUrl = `${url}${sep}cpn=${cpn}&c=WEB_EMBEDDED_PLAYER&cver=1.20260224.08.00`;
  const proxyUrl = `${PUBLIC_URL}/proxy/segment?url=${encodeURIComponent(finalUrl)}&referer=${encodeURIComponent('https://www.blogger.com/')}`;
  const label = QUALITY_LABEL[quality] || `${quality}p`;

  return {
    url: proxyUrl,
    name: `AniTube | ${tabName}`,
    title: `${label} • GoogleVideo`,
    description: `GoogleVideo ${label} (itag ${itag})`,
    behaviorHints: { notWebReady: false, bingeGroup: `anitube-${tabName.toLowerCase().replace(/\s+/g, '-')}` },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// EXTRAÇÃO DE IFRAMES GENÉRICOS
// ───────────────────────────────────────────────────────────────────────────

async function extractFromProxyIframe(iframeSrc, episodeReferer) {
  const streams = [];
  try {
    const res = await safeFetch(iframeSrc, {
      headers: { ...FETCH_HEADERS, Referer: episodeReferer || config.baseUrl + '/' },
      redirect: 'follow',
    }, 12000, 2);
    if (!res.ok) return streams;
    const html = await res.text();

    const bloggerMatch = html.match(/src=["'](https?:\/\/(?:www\.)?blogger\.com\/video\.g[^"']+)["']/i);
    if (bloggerMatch) {
      const bloggerUrl = bloggerMatch[1].replace(/&amp;/g, '&');
      const token = extractBloggerToken(bloggerUrl);
      if (token) {
        const googleVideos = await fetchBloggerStreams(token, episodeReferer);
        for (const vid of googleVideos) streams.push(makeGoogleVideoStream('Player 1', vid));
      }
      return streams;
    }

    const m3u8Patterns = [
      /["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i,
      /source\s+src=["'](https?:\/\/[^"']+\.m3u8[^"']*)/i,
      /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i,
      /hls\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i,
      /src\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i,
    ];

    for (const pattern of m3u8Patterns) {
      const m3u8Match = html.match(pattern);
      if (m3u8Match) {
        const m3u8Url = m3u8Match[1].replace(/&amp;/g, '&');
        const proxyUrl = `${PUBLIC_URL}/proxy/hls.m3u8?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(episodeReferer || 'https://www.anitube.news/')}`;
        streams.push({
          url: proxyUrl,
          name: 'AniTube | Player 1',
          title: 'HLS • Auto',
          description: 'HLS Stream (Via Proxy)',
          behaviorHints: { notWebReady: true, bingeGroup: 'anitube-hls' },
        });
        break;
      }
    }
  } catch (e) {
    log.warn(`extractFromProxyIframe erro ${iframeSrc}: ${e.message}`);
  }
  return streams;
}

// ───────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL
// ───────────────────────────────────────────────────────────────────────────

async function extractStreams(sources, episodeUrl) {
  const episodeReferer = episodeUrl || config.baseUrl + '/';
  if (!Array.isArray(sources) || sources.length === 0) return [];

  // Processa sources em paralelo mas limitado (evita burst)
  const tasks = sources.map(async (source) => {
    const { name, iframeSrc } = source;
    if (!iframeSrc) return [];
    const fullIframeSrc = iframeSrc.startsWith('//') ? 'https:' + iframeSrc : iframeSrc;
    const streams = [];

    // Tipo 1: videohls.php — proxy HLS direto
    if (fullIframeSrc.includes('videohls.php') || fullIframeSrc.includes('anivideo.net/videohls')) {
      const hlsUrl = extractHLSFromVideoHLS(fullIframeSrc);
      if (hlsUrl) {
        const proxyUrl = `${PUBLIC_URL}/proxy/hls.m3u8?url=${encodeURIComponent(hlsUrl)}&referer=${encodeURIComponent('https://anivideo.net/')}`;
        streams.push({
          url: proxyUrl,
          name: `AniTube | ${name}`,
          title: 'FHD • HLS',
          description: '[FHD] HLS Stream (Via Proxy Local)',
          behaviorHints: { notWebReady: true, bingeGroup: `anitube-${name.toLowerCase().replace(/\s+/g, '-')}` },
        });
      }
      return streams;
    }

    // Tipo 2: proxy AniTube -> Blogger
    if ((fullIframeSrc.includes('anitube.news/') || fullIframeSrc.includes('anitube.zip/') || fullIframeSrc.includes('anitube.site/')) && !fullIframeSrc.includes('videohls.php')) {
      const extracted = await extractFromProxyIframe(fullIframeSrc, episodeReferer);
      return extracted.map(s => ({ ...s, name: `AniTube | ${name}` }));
    }

    // Tipo 3: Blogger direto
    if (fullIframeSrc.includes('blogger.com/video.g')) {
      const token = extractBloggerToken(fullIframeSrc);
      if (token) {
        const googleVideos = await fetchBloggerStreams(token, episodeReferer);
        return googleVideos.map(vid => makeGoogleVideoStream(name, vid));
      }
      return streams;
    }

    // Tipo 4: Genérico
    const extracted = await extractFromProxyIframe(fullIframeSrc, episodeReferer);
    return extracted.map(s => ({ ...s, name: `AniTube | ${name}` }));
  });

  const settled = await Promise.allSettled(tasks);
  const out = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) out.push(...r.value);
  }

  // Dedup por URL
  const seen = new Set();
  return out.filter(s => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

module.exports = { extractStreams, extractHLSFromVideoHLS, parseGoogleVideoUrls };
