'use strict';

require('dotenv').config();

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const addonInterface = require('./addon');

const app        = express();
const PORT       = parseInt(process.env.PORT || '7000', 10);

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

const UA_PROXY = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
                 '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

// ── Segurança: SSRF Block ─────────────────────────────────────────────────────
const ALLOWED_DOMAINS = [
  'anitube.news', 'anitube.zip', 'anitube.site', 'blogger.com', 'googlevideo.com', 'anivideo.net', 'blogspot.com'
];
function isAllowedUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return ALLOWED_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

function getPublicUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

// ── CORS e Estáticos ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  next();
});

app.use(express.static(path.join(__dirname, 'src', 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'src', 'public', 'index.html')));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'src', 'public', 'index.html')));

// ── Utilitário ────────────────────────────────────────────────────────────────
function resolveUrl(base, relative) {
  if (!relative) return base;
  if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
  if (relative.startsWith('//')) return 'https:' + relative;
  try {
    return new URL(relative, base).toString();
  } catch (_) {
    return base.substring(0, base.lastIndexOf('/') + 1) + relative;
  }
}

function getAgent(parsedUrl) {
  return parsedUrl.protocol === 'http:' ? httpAgent : httpsAgent;
}

// ── Proxy M3U8 ────────────────────────────────────────────────────────────────
app.get('/proxy/hls.m3u8', handleM3U8);
app.get('/proxy/m3u8', handleM3U8);

async function handleM3U8(req, res) {
  const { url, referer, _passthrough } = req.query;
  if (!url) return res.status(400).send('Parâmetro "url" obrigatório');
  if (!isAllowedUrl(url)) return res.status(403).send('URL não permitida pelo proxy');

  try {
    const upstream = await fetch(url, {
      agent: getAgent(new URL(url)),
      headers: {
        'User-Agent': UA_PROXY,
        'Referer'   : referer || 'https://www.anitube.news/',
        'Origin'    : 'https://www.anitube.news',
        'Accept'    : '*/*',
      },
    });

    if (!upstream.ok) return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);

    const text    = await upstream.text();
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const encRef  = encodeURIComponent(referer || 'https://www.anitube.news/');
    const isMaster = text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA:');
    const needsCodecHint = !_passthrough && !isMaster && !text.includes('CODECS=');

    const lines = text.split('\n');
    const rewritten = [];
    const publicUrl = getPublicUrl(req);

    if (needsCodecHint) {
      rewritten.push('#EXTM3U');
      rewritten.push(`#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42E01E,mp4a.40.2",RESOLUTION=1280x720`);
      rewritten.push(`${publicUrl}/proxy/hls.m3u8?url=${encodeURIComponent(url)}&referer=${encRef}&_passthrough=1`);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(rewritten.join('\n'));
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { rewritten.push(raw); continue; }

      if (line.startsWith('#')) {
        rewritten.push(line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const full = resolveUrl(baseUrl, uri);
          return `URI="${publicUrl}/proxy/hls.m3u8?url=${encodeURIComponent(full)}&referer=${encRef}"`;
        }));
        continue;
      }

      const full = resolveUrl(baseUrl, line);
      const pathOnly = full.split('?')[0];
      if (isMaster || pathOnly.endsWith('.m3u8')) {
        rewritten.push(`${publicUrl}/proxy/hls.m3u8?url=${encodeURIComponent(full)}&referer=${encRef}`);
      } else {
        rewritten.push(`${publicUrl}/proxy/segment?url=${encodeURIComponent(full)}&referer=${encRef}`);
      }
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewritten.join('\n'));

  } catch (e) {
    console.error('[Proxy M3U8]', e.message);
    res.status(500).send(e.message);
  }
}

// ── Proxy Segmento ────────────────────────────────────────────────────────────
app.get('/proxy/segment', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('Parâmetro "url" obrigatório');
  if (!isAllowedUrl(url)) return res.status(403).send('URL não permitida pelo proxy');

  try {
    const reqHeaders = {
      'User-Agent': UA_PROXY,
      'Referer'   : referer || 'https://www.anitube.news/',
      'Origin'    : 'https://www.anitube.news',
      'Accept'    : '*/*',
    };

    if (req.headers.range) reqHeaders.Range = req.headers.range;

    const upstream = await fetch(url, {
      agent: getAgent(new URL(url)),
      headers: reqHeaders
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);
    }

    const upstreamCT    = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentRange  = upstream.headers.get('content-range');
    let   contentLength = upstream.headers.get('content-length');

    if (!contentLength && contentRange) {
      const m = contentRange.match(/bytes (\d+)-(\d+)\//);
      if (m) contentLength = String(parseInt(m[2]) - parseInt(m[1]) + 1);
    }

    res.setHeader('Accept-Ranges', 'bytes');

    const isAmbiguous = upstreamCT === 'application/octet-stream' || upstreamCT === 'image/webp';

    if (isAmbiguous) {
      const body = upstream.body;
      const firstChunk = await new Promise(resolve => {
        body.once('data', resolve);
        body.once('end', () => resolve(null));
        body.once('error', () => resolve(null));
      });

      const contentType = (firstChunk && firstChunk[0] === 0x47) ? 'application/octet-stream' : upstreamCT;

      res.status(upstream.status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (contentRange)  res.setHeader('Content-Range', contentRange);
      if (contentLength) res.setHeader('Content-Length', contentLength);

      if (firstChunk) res.write(firstChunk);
      body.pipe(res);
      return;
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', upstreamCT);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (contentRange)  res.setHeader('Content-Range', contentRange);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipe(res);

  } catch (e) {
    console.error('[Proxy Segmento]', e.message);
    res.status(500).send(e.message);
  }
});

// ── Stremio Addon Roteamento ──────────────────────────────────────────────────
app.get('/:config?/manifest.json', async (req, res) => {
  try {
    let manifest = await addonInterface.get('manifest');
    manifest = JSON.parse(JSON.stringify(manifest));
    
    if (req.params.config) {
      manifest.behaviorHints.configurationRequired = false;
      
      const configParts = req.params.config.split('|');
      for (const part of configParts) {
        const [k, v] = part.split('=');
        if (k === 'tmdb' && v) {
          manifest.tmdbApiKey = v;
        }
      }
    }
    
    res.setHeader('Cache-Control', 'max-age=86400, staled-while-revalidate=2592000, public');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(manifest);
  } catch (e) {
    res.status(500).json({ err: 'manifest error' });
  }
});

const handleAddonRoute = async (req, res) => {
  try {
    let { config, resource, type, id, extra } = req.params;
    let extraObj = {};
    if (extra) {
      const extraParams = new URLSearchParams(extra);
      for (const [k, v] of extraParams) extraObj[k] = v;
    }

    const args = { type, id, extra: extraObj };
    let result = await addonInterface.get(resource, args);

    if (result && result.streams) {
      const publicUrl = getPublicUrl(req);
      result = JSON.parse(JSON.stringify(result).replace(/\{\{PUBLIC_URL\}\}/g, publicUrl));
    }

    res.setHeader('Cache-Control', 'max-age=86400, staled-while-revalidate=2592000, public');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ err: 'handler error' });
  }
};

app.get('/:config?/:resource/:type/:id/:extra?.json', handleAddonRoute);
app.get('/:config?/:resource/:type/:id.json', handleAddonRoute);

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║      🎌 AniTube.news – Stremio Addon v4.2     ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Porta   : ${PORT}`);
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
});
