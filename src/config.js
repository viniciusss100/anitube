'use strict';

require('dotenv').config();

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}

const config = {
  port: parseIntEnv('PORT', 7000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  tmdbApiKey: process.env.TMDB_API_KEY || '',

  // Express: confia no header X-Forwarded-For/Proto quando atrás de
  // proxy/reverse-proxy (Render, Nginx, etc.) — evita falso positivo do
  // express-rate-limit (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
  // Valores aceitos: true | false | <nº de hops> | CIDR/subnet
  trustProxy: (() => {
    const raw = process.env.TRUST_PROXY;
    if (raw === undefined || raw === '') {
      return (process.env.RENDER === 'true' || process.env.VERCEL === '1' || process.env.NODE_ENV === 'production') ? 1 : false;
    }
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    if (/^\d+$/.test(v)) return parseInt(v, 10);
    return raw.trim();
  })(),

  // Bases alternativas do AniTube (fallback em ordem)
  anitubeBases: (process.env.ANITUBE_BASES || 'https://www.anitube.zip,https://www.anitube.news,https://www.anitube.site')
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean),

  kitsuBaseUrl: process.env.KITSU_BASE_URL || 'https://kitsufortheweebs.midnightignite.me',

  // Tuning
  cache: {
    ttlMs: parseIntEnv('CACHE_TTL_MS', 2 * 60 * 1000),
    maxKeys: parseIntEnv('CACHE_MAX_KEYS', 1000),
    homeTtlMs: parseIntEnv('HOME_TTL_MS', 60 * 1000),
  },

  http: {
    timeoutMs: parseIntEnv('HTTP_TIMEOUT_MS', 8000),
    scraperTimeoutMs: parseIntEnv('SCRAPER_TIMEOUT_MS', 15000),
    retries: parseIntEnv('HTTP_RETRIES', 3),
    concurrency: parseIntEnv('SCRAPER_CONCURRENCY', 5),

    // Proxy externo (http/socks) usado para TODAS as requisições do scraper.
    // Contorna bloqueio de IP do provedor (ex: 403 do Cloudflare do AniTube).
    // Ex: http://user:pass@host:port | http://host:port
    externalProxy: (process.env.SCRAPE_PROXY || '').trim(),

    // Fallback alternativo quando o IP direto está bloqueado (403/429):
    // lista de CORS/relay proxies públicos ou próprios. Use {url} como
    // placeholder do alvo. Vazio desabilita o fallback.
    corsProxies: (process.env.SCRAPE_CORS_PROXIES || 'https://api.allorigins.win/raw?url={url},https://corsproxy.io/?url={url}')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  },

  proxy: {
    allowedDomains: (process.env.PROXY_ALLOWED_DOMAINS || 'anitube.news,anitube.zip,anitube.site,blogger.com,googlevideo.com,anivideo.net,blogspot.com,googleusercontent.com')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
    // Se true, bloqueia IPs privados mesmo que domínio seja permitido
    blockPrivateIps: process.env.PROXY_BLOCK_PRIVATE_IPS !== 'false',
  },

  tmdb: {
    imageBase: 'https://image.tmdb.org/t/p/w500',
    cacheTtlMs: parseIntEnv('TMDB_CACHE_TTL_MS', 24 * 60 * 60 * 1000),
  },
};

// Compat: BASE_URL legado = primeira base
config.baseUrl = config.anitubeBases[0];

module.exports = config;
