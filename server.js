'use strict';

require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream');
const { promisify } = require('util');
const addonInterface = require('./addon');
const config = require('./src/config');
const logger = require('./src/logger');
const cache = require('./src/cache');

const log = logger.child('server');
const app = express();
const PORT = config.port;

let helmet, cors, morgan, compression, rateLimit;
try { helmet = require('helmet'); } catch (_) { helmet = null; }
try { cors = require('cors'); } catch (_) { cors = null; }
try { morgan = require('morgan'); } catch (_) { morgan = null; }
try { compression = require('compression'); } catch (_) { compression = null; }
try { rateLimit = require('express-rate-limit'); } catch (_) { rateLimit = null; }

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

const UA_PROXY = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

// ── Middlewares base ────────────────────────────────────────────────────────
if (helmet) app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false,
}));
if (cors) app.use(cors({ origin: '*', exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'] }));
else {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}
if (compression) app.use(compression());
if (morgan) app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'src', 'public'), { maxAge: '1h', etag: true }));

// Rate limit leve para proxies
if (rateLimit) {
  const proxyLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
  app.use('/proxy/', proxyLimiter);
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
  app.use('/:resource/:type/:id', apiLimiter);
}

// ── Utilitários ─────────────────────────────────────────────────────────────
function getPublicUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

function resolveUrl(base, relative) {
  if (!relative) return base;
  if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
  if (relative.startsWith('//')) return 'https:' + relative;
  try { return new URL(relative, base).toString(); } catch (_) {
    return base.substring(0, base.lastIndexOf('/') + 1) + relative;
  }
}

function getAgent(parsedUrl) {
  return parsedUrl.protocol === 'http:' ? httpAgent : httpsAgent;
}

function isAllowedUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;

    // Bloqueia IPs privados se configurado
    if (config.proxy.blockPrivateIps) {
      const host = u.hostname;
      if (/^127\./.test(host) || host === 'localhost' || host === '::1' || host === '0.0.0.0') return false;
      if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
      if (/^169\.254\./.test(host)) return false;
    }

    // Se allowedDomains vazio, permite tudo (compat)
    if (!config.proxy.allowedDomains.length) return true;
    const hostname = u.hostname.toLowerCase();
    return config.proxy.allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

// Timeout helper para fetch
function fetchWithTimeout(url, opts = {}, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ── Health & Diagnostics ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: addonInterface.manifest?.version || 'unknown', uptime: process.uptime(), cache: cache.stats() });
});
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'src', 'public', 'index.html')));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'src', 'public', 'index.html')));

// ── Proxy M3U8 ───────────────────────────────────────────────────────────────
app.get('/proxy/hls.m3u8', handleM3U8);
app.get('/proxy/m3u8', handleM3U8);

async function handleM3U8(req, res) {
  const { url, referer, _passthrough } = req.query;
  if (!url) return res.status(400).send('Parâmetro "url" obrigatório');
  if (!isAllowedUrl(url)) {
    log.warn(`Proxy M3U8 bloqueado: ${url}`);
    return res.status(403).send('URL não permitida pelo proxy');
  }

  try {
    const upstream = await fetchWithTimeout(url, {
      agent: getAgent(new URL(url)),
      headers: {
        'User-Agent': UA_PROXY,
        Referer: referer || 'https://anivideo.net/',
        Accept: '*/*',
      },
    }, 10000);

    if (!upstream.ok) return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);
    const text = await upstream.text();
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const encRef = encodeURIComponent(referer || 'https://www.anitube.news/');
    const isMaster = text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA:');
    const needsCodecHint = !_passthrough && !isMaster && !text.includes('CODECS=');

    const lines = text.split('\n');
    const rewritten = [];
    const publicUrl = getPublicUrl(req);

    if (needsCodecHint) {
      rewritten.push('#EXTM3U');
      rewritten.push('#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42E01E,mp4a.40.2",RESOLUTION=1280x720');
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten.join('\n'));
  } catch (e) {
    const isAbort = e.name === 'AbortError';
    log.error(`[Proxy M3U8] ${isAbort ? 'timeout' : e.message} url=${url}`);
    if (!res.headersSent) res.status(isAbort ? 504 : 500).send(isAbort ? 'Upstream timeout' : 'Proxy error');
  }
}

// ── Proxy Segmento ───────────────────────────────────────────────────────────
app.get('/proxy/segment', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send('Parâmetro "url" obrigatório');
  if (!isAllowedUrl(url)) {
    log.warn(`Proxy segment bloqueado: ${url}`);
    return res.status(403).send('URL não permitida pelo proxy');
  }

  try {
    const reqHeaders = {
      'User-Agent': UA_PROXY,
      Referer: referer || 'https://anivideo.net/',
      Accept: '*/*',
    };
    if (req.headers.range) reqHeaders.Range = req.headers.range;

    const upstream = await fetchWithTimeout(url, {
      agent: getAgent(new URL(url)),
      headers: reqHeaders,
    }, 15000);

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream retornou ${upstream.status}`);
    }

    const upstreamCT = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentRange = upstream.headers.get('content-range');
    let contentLength = upstream.headers.get('content-length');

    if (!contentLength && contentRange) {
      const m = contentRange.match(/bytes (\d+)-(\d+)\//);
      if (m) contentLength = String(parseInt(m[2]) - parseInt(m[1]) + 1);
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Detecção de tipo ambíguo via magic bytes
    const isAmbiguous = upstreamCT === 'application/octet-stream' || upstreamCT === 'image/webp' || upstreamCT.includes('octet-stream');
    if (isAmbiguous && upstream.body) {
      const body = upstream.body;
      const firstChunk = await new Promise(resolve => {
        let done = false;
        const onData = (chunk) => { if (!done) { done = true; cleanup(); resolve(chunk); } };
        const onEnd = () => { if (!done) { done = true; cleanup(); resolve(null); } };
        const onError = () => { if (!done) { done = true; cleanup(); resolve(null); } };
        const cleanup = () => { body.off('data', onData); body.off('end', onEnd); body.off('error', onError); };
        body.once('data', onData);
        body.once('end', onEnd);
        body.once('error', onError);
      });

      const contentType = (firstChunk && firstChunk[0] === 0x47) ? 'video/MP2T' : upstreamCT;
      res.status(upstream.status);
      res.setHeader('Content-Type', contentType);
      if (contentRange) res.setHeader('Content-Range', contentRange);
      if (contentLength) res.setHeader('Content-Length', contentLength);
      if (firstChunk) res.write(firstChunk);
      if (body && !body.destroyed) body.pipe(res);
      return;
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', upstreamCT);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (upstream.body) upstream.body.pipe(res);
    else res.end();
  } catch (e) {
    const isAbort = e.name === 'AbortError';
    log.error(`[Proxy Segmento] ${isAbort ? 'timeout' : e.message} url=${req.query.url}`);
    if (!res.headersSent) res.status(isAbort ? 504 : 500).send(isAbort ? 'Upstream timeout' : 'Proxy error');
  }
});

// ── Stremio Addon Roteamento ─────────────────────────────────────────────────
function parseConfigParam(param) {
  const out = {};
  if (!param || param === 'manifest.json') return out;
  const parts = param.split('|');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq);
    const v = decodeURIComponent(part.slice(eq + 1));
    if (k && v) out[k] = v;
  }
  return out;
}

async function handleManifest(req, res) {
  try {
    let manifest = JSON.parse(JSON.stringify(addonInterface.manifest));
    const cfg = parseConfigParam(req.params.config);
    if (Object.keys(cfg).length) {
      manifest.behaviorHints = { ...manifest.behaviorHints, configurationRequired: false };
      if (cfg.tmdb) manifest._hasTmdbKey = true;
    }
    res.setHeader('Cache-Control', 'max-age=86400, stale-while-revalidate=2592000, public');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(manifest);
  } catch (e) {
    log.error(`manifest error: ${e.message}`);
    res.status(500).json({ err: 'manifest error' });
  }
}
app.get('/manifest.json', handleManifest);
app.get('/:config/manifest.json', handleManifest);

// Handler unificado para rotas Stremio
const handleAddonRoute = async (req, res) => {
  try {
    let { config: cfgParam, resource, type, id, extra } = req.params;
    // Express opcional params: se cfgParam parece ser resource, shift
    const validResources = new Set(['catalog', 'meta', 'stream']);
    if (cfgParam && validResources.has(cfgParam) && !resource) {
      // rota sem config: /catalog/...  mas capturada como :config
      resource = cfgParam;
      type = req.params.type || req.params.resource;
      id = req.params.id || req.params.type;
      extra = req.params.extra || req.params.id;
      cfgParam = null;
    }

    let extraObj = {};
    if (extra) {
      const raw = extra.endsWith('.json') ? extra.slice(0, -5) : extra;
      // extra pode ser "skip=20&search=naruto" ou "skip=20"
      const extraParams = new URLSearchParams(raw);
      for (const [k, v] of extraParams) extraObj[k] = v;
    }

    // Suporte a .json no id (caso sem extra)
    if (id && id.endsWith('.json')) id = id.slice(0, -5);

    if (!resource || !type || !id) {
      return res.status(400).json({ err: 'missing params' });
    }

    if (!validResources.has(resource)) return res.status(404).json({ err: 'unknown resource' });

    const result = await addonInterface.get(resource, type, id, extraObj);

    let out = result;
    if (result && result.streams) {
      const publicUrl = getPublicUrl(req);
      out = JSON.parse(JSON.stringify(result).replace(/\{\{PUBLIC_URL\}\}/g, publicUrl));
    }

    res.setHeader('Cache-Control', resource === 'stream' ? 'max-age=300, public' : 'max-age=86400, stale-while-revalidate=2592000, public');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(out);
  } catch (err) {
    log.error(`handler error ${req.path}: ${err.stack || err.message}`);
    if (!res.headersSent) res.status(500).json({ err: 'handler error' });
  }
};

// Rotas ordenadas (mais específicas primeiro)
app.get('/:config/:resource/:type/:id/:extra.json', handleAddonRoute);
app.get('/:config/:resource/:type/:id.json', handleAddonRoute);
app.get('/:resource/:type/:id/:extra.json', handleAddonRoute);
app.get('/:resource/:type/:id.json', handleAddonRoute);

// 404
app.use((req, res) => res.status(404).json({ err: 'not found' }));

// Error handler global
app.use((err, req, res, _next) => {
  log.error(`Unhandled ${req.method} ${req.path}: ${err.stack || err.message}`);
  if (!res.headersSent) res.status(500).json({ err: 'internal error' });
});

// ── Start + Graceful shutdown ────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║      🎌 AniTube.news – Stremio Addon v4.3     ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Porta   : ${PORT}                             `);
  console.log(`║  Bases   : ${config.anitubeBases.join(', ')}`);
  console.log(`║  Kitsu   : ${config.kitsuBaseUrl}`);
  console.log(`║  Public  : ${config.publicUrl || '(auto)'}   `);
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
});

function shutdown(signal) {
  log.info(`Recebido ${signal}, encerrando...`);
  server.close(() => {
    log.info('Servidor encerrado');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error(`unhandledRejection: ${err?.stack || err}`));
process.on('uncaughtException', (err) => { log.error(`uncaughtException: ${err?.stack || err}`); });

module.exports = app;
