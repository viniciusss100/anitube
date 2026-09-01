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
