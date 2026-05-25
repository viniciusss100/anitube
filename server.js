'use strict';

require('dotenv').config();

const express = require('express');
const fetch   = require('node-fetch');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const app        = express();
const PORT       = parseInt(process.env.PORT || '7000', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

const UA_PROXY = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
                 '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  next();
});

// ── Utilitário: resolve URL relativa em relação a uma base ────────────────────
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

// ── Proxy M3U8 ────────────────────────────────────────────────────────────────
// Rota com extensão .m3u8 para que ExoPlayer/VLC detectem HLS pela URL
app.get('/proxy/hls.m3u8', handleM3U8);
app.get('/proxy/m3u8', handleM3U8);

async function handleM3U8(req, res) {
  const { url, referer, _passthrough } = req.query;
  if (!url) return res.status(400).send('Parâmetro "url" obrigatório');

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': UA_PROXY,
        'Referer'   : referer || 'https://www.anitube.news/',
        'Origin'    : 'https://www.anitube.news',
        'Accept'    : '*/*',
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);
    }

    const text    = await upstream.text();
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const encRef  = encodeURIComponent(referer || 'https://www.anitube.news/');

    const isMaster = text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA:');

    // Se for media playlist sem declaração de codecs e sem _passthrough,
    // injeta um master playlist wrapper com CODECS para que o ExoPlayer
    // saiba que há vídeo H.264 + áudio AAC e use o extrator correto.
    const needsCodecHint = !_passthrough && !isMaster && !text.includes('CODECS=');

    const lines = text.split('\n');
    const rewritten = [];

    if (needsCodecHint) {
      // Injeta um pseudo master playlist wrapper que declara os codecs
      // Isso faz o ExoPlayer usar o extrator correto para MPEG-TS com AAC
      rewritten.push('#EXTM3U');
      rewritten.push(`#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42E01E,mp4a.40.2",RESOLUTION=1280x720`);
      rewritten.push(`${PUBLIC_URL}/proxy/hls.m3u8?url=${encodeURIComponent(url)}&referer=${encRef}&_passthrough=1`);
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
          return `URI="${PUBLIC_URL}/proxy/hls.m3u8?url=${encodeURIComponent(full)}&referer=${encRef}"`;
        }));
        continue;
      }

      const full = resolveUrl(baseUrl, line);
      const pathOnly = full.split('?')[0];
      if (isMaster || pathOnly.endsWith('.m3u8')) {
        rewritten.push(`${PUBLIC_URL}/proxy/hls.m3u8?url=${encodeURIComponent(full)}&referer=${encRef}`);
      } else {
        rewritten.push(`${PUBLIC_URL}/proxy/segment?url=${encodeURIComponent(full)}&referer=${encRef}`);
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

  try {
    const reqHeaders = {
      'User-Agent': UA_PROXY,
      'Referer'   : referer || 'https://www.anitube.news/',
      'Origin'    : 'https://www.anitube.news',
      'Accept'    : '*/*',
    };

    if (req.headers.range) reqHeaders.Range = req.headers.range;

    const upstream = await fetch(url, { headers: reqHeaders });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);
    }

    const upstreamCT    = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentRange  = upstream.headers.get('content-range');
    let   contentLength = upstream.headers.get('content-length');

    // Calcula Content-Length a partir do Content-Range quando o upstream não o fornece
    // Ex: "bytes 0-65535/1507384" → length = 65536
    if (!contentLength && contentRange) {
      const m = contentRange.match(/bytes (\d+)-(\d+)\//);
      if (m) contentLength = String(parseInt(m[2]) - parseInt(m[1]) + 1);
    }

    // ExoPlayer exige Accept-Ranges para saber que pode fazer range requests
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

// ── Stremio Addon SDK ─────────────────────────────────────────────────────────
app.use(getRouter(addonInterface));

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║      🎌 AniTube.news – Stremio Addon v4.1     ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Porta   : ${PORT}`);
  console.log(`║  Instalar: ${PUBLIC_URL}/manifest.json`);
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
});
