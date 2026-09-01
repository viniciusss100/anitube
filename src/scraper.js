'use strict';

/**
 * Scraper para AniTube — v4.1.0
 * Melhorias:
 *  - Config centralizada + fallback multi-domínio
 *  - fetchHTML com retry exponencial + jitter + AbortController
 *  - Pool de concorrência limitada (evita ban)
 *  - Deduplicação de home (promise coalescing)
 *  - TMDB com cache negativo e concorrência limitada
 *  - Parsers mais resilientes
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const config = require('./config');
const logger = require('./logger');

const log = logger.child('scraper');

const BASE_URL = config.baseUrl;
const BASES = config.anitubeBases;

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Referer: BASE_URL + '/',
};

// Proxy externo obrigatório (SCRAPE_PROXY). Aplica em todas requisições.
let proxyAgent = null;
if (config.http.externalProxy) {
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    proxyAgent = new HttpsProxyAgent(config.http.externalProxy);
    log.info(`Scraper usando proxy externo: ${config.http.externalProxy.replace(/\/\/[^@]*(@)/, '//***$1')}`);
  } catch (e) {
    log.warn(`SCRAPE_PROXY definido mas https-proxy-agent indisponível: ${e.message}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────────────────────

function jitter(ms) {
  return ms + Math.floor(Math.random() * 250);
}

/**
 * Busca HTML com retry automático, backoff exponencial + jitter.
 * Tenta bases alternativas em caso de falha de rede/dns.
 * Se o IP direto estiver bloqueado (403/429), cai para os CORS/relay proxies
 * configurados em SCRAPE_CORS_PROXIES (contorna bloqueio por IP).
 */
async function fetchHTML(url, timeout = config.http.scraperTimeoutMs, retries = config.http.retries) {
  // Se url usa BASE_URL, tenta todas as bases em ordem como fallback
  const urlsToTry = (() => {
    for (const base of BASES) {
      if (url.startsWith(base)) return [url];
    }
    // Se url começa com BASE_URL original, gerar variantes
    if (url.includes('anitube')) {
      return BASES.map(b => {
        try {
          const u = new URL(url);
          const baseHost = new URL(b).host;
          u.host = baseHost;
          u.protocol = 'https:';
          return u.toString();
        } catch (_) { return url; }
      });
    }
    return [url];
  })();

  let lastErr;
  for (const tryUrl of urlsToTry) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const opts = { headers: FETCH_HEADERS, signal: ctrl.signal };
        if (proxyAgent) opts.agent = proxyAgent;
        const res = await fetch(tryUrl, opts);
        if (!res.ok) throw new Error(`HTTP ${res.status} para ${tryUrl}`);
        return await res.text();
      } catch (err) {
        lastErr = err;
        const isAbort = err.name === 'AbortError';
        const msg = isAbort ? `timeout ${timeout}ms` : err.message;
        if (attempt === retries) break; // tenta próxima base
        const wait = jitter(attempt * 600); // 600, 1200, 1800 + jitter
        log.warn(`Retry ${attempt}/${retries} para ${tryUrl} (${msg}) - aguardando ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // ── Fallback: CORS/relay proxy (bloqueio de IP) ──────────────────────
  if (config.http.corsProxies.length) {
    const viaCors = await fetchViaCorsProxies(urlsToTry, Math.min(timeout, 10000));
    if (viaCors != null) return viaCors;
  }

  throw lastErr;
}

// Tenta baixar o HTML através dos CORS proxies configurados.
// Formato do proxy: pode usar {url} como placeholder ou simplesmente
// concatenar a URL codificada ao final.
async function fetchViaCorsProxies(urls, timeout) {
  for (const proxy of config.http.corsProxies) {
    for (const targetUrl of urls) {
      const wrapped = proxy.includes('{url}')
        ? proxy.replace('{url}', encodeURIComponent(targetUrl))
        : proxy + encodeURIComponent(targetUrl);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const opts = { headers: FETCH_HEADERS, signal: ctrl.signal };
        if (proxyAgent) opts.agent = proxyAgent;
        const res = await fetch(wrapped, opts);
        if (res.ok) {
          const text = await res.text();
          if (text && text.length > 500) {
            log.info(`CORS proxy ${proxy.split('?')[0]} obteve ${targetUrl} (${res.status})`);
            return text;
          }
        }
        log.warn(`CORS proxy ${proxy.split('?')[0]} retornou ${res.status} para ${targetUrl}`);
      } catch (err) {
        log.warn(`CORS proxy ${proxy.split('?')[0]} falhou para ${targetUrl}: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ───────────────────────────────────────────────────────────────────────────

function extractId(url) {
  if (!url || typeof url !== 'string') return null;
  let m = url.match(/\/video\/(\d+)\/?/);
  if (m) return m[1];
  m = url.match(/\/(\d{4,})b\/?(?:[#?]|$)/);
  if (m) return m[1];
  // fallback: último segmento numérico
  m = url.match(/\/(\d{3,})\/?(?:[#?]|$)/);
  if (m) return m[1];
  return null;
}

function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\s*[–—-]\s*Todos os Epis.+$/i, '')
    .replace(/\s*[–—-]\s*Epis[oó]dio\s*\d+.*$/i, '')
    .replace(/\s*[–—-]\s*Epis[oó]dios.*$/i, '')
    .replace(/\s*\(\s*(dublado|legendado)\s*\)\s*$/i, '')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEpisodeNumber(title) {
  if (!title || typeof title !== 'string') return null;
  const patterns = [
    /Epis[oó]dio\s*(\d+)/i,
    /\bEpis[oó]dio\s*0*(\d+)\b/i,
    /\bEp\.?\s*0*(\d+)\b/i,
    /\bE0*(\d+)\b/,
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0 && n < 5000) return n;
    }
  }
  // Evita falsos positivos: só aceita número isolado se título parece ser de episódio
  if (/epis[oó]dio|ep\b/i.test(title)) {
    const m = title.match(/\b(\d{1,4})\b/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < 5000) return n;
    }
  }
  return null;
}

function makeMetaPreview(id, name, poster) {
  return {
    id: `anitube:${id}`,
    type: 'series',
    name: cleanTitle(name),
    poster: poster || '',
    posterShape: 'poster',
  };
}

function makeLatestEpisodePreview(seriesId, episodeId, name, poster) {
  const seriesName = cleanTitle(name);
  return {
    id: `anitube:${seriesId}`,
    type: 'series',
    name: seriesName,
    description: name,
    poster: poster || '',
    posterShape: 'poster',
    behaviorHints: {
      defaultVideoId: `anitube:${episodeId}`,
    },
  };
}

function extractImgSrc($el) {
  if (!$el || !$el.attr) return '';
  return (
    $el.attr('src') ||
    $el.attr('data-src') ||
    $el.attr('data-lazy-src') ||
    $el.attr('data-original') ||
    ''
  ).trim();
}

// Limita concorrência para operações pesadas
function createLimiter(concurrency) {
  let running = 0;
  const queue = [];
  const run = async (fn) => {
    if (running >= concurrency) {
      await new Promise(resolve => queue.push(resolve));
    }
    running++;
    try { return await fn(); } finally {
      running--;
      if (queue.length) queue.shift()();
    }
  };
  return run;
}
const limit = createLimiter(config.http.concurrency);

// ───────────────────────────────────────────────────────────────────────────
// PARSERS
// ───────────────────────────────────────────────────────────────────────────

function parseAniItems($, $elements) {
  const results = [];
  const seen = new Set();
  $elements.each((_, el) => {
    const $a = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id = extractId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name = ($a.attr('title') || $(el).find('.aniItemNome').first().text().trim() || $a.text().trim());
    const poster = extractImgSrc($(el).find('img').first());
    if (!name) return;
    results.push(makeMetaPreview(id, name, poster));
  });
  return results;
}

function parseEpiItems($) {
  const results = [];
  const seen = new Set();
  $('div.epiItem').each((_, el) => {
    const $a = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id = extractId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rawName = ($a.attr('title') || $(el).find('.epiItemNome').first().text() || $a.text() || '').trim();
    const poster = extractImgSrc($(el).find('img').first());
    if (!rawName) return;
    results.push({
      id: `anitube:${id}`,
      type: 'series',
      name: rawName,
      poster,
      posterShape: 'poster',
    });
  });
  return results;
}

function findContainerByKeywords($, keywords) {
  let found = null;
  $('.aniContainer').each((_, container) => {
    if (found) return false;
    const title = $(container).find('.aniContainerTitulo').first().text().toLowerCase();
    if (keywords.some(k => title.includes(k.toLowerCase()))) {
      found = container;
    }
  });
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// HOME (compartilhado + deduplicação)
// ───────────────────────────────────────────────────────────────────────────

let _homeCache = null;
let _homeCacheTs = 0;
let _homePromise = null;

async function getHomePage() {
  const now = Date.now();
  if (_homeCache && now - _homeCacheTs < config.cache.homeTtlMs) return _homeCache;
  if (_homePromise) return _homePromise;

  _homePromise = (async () => {
    const html = await fetchHTML(BASE_URL + '/');
    const $ = cheerio.load(html);
    _homeCache = $;
    _homeCacheTs = Date.now();
    return $;
  })();

  try {
    return await _homePromise;
  } finally {
    _homePromise = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// FUNÇÕES PÚBLICAS
// ───────────────────────────────────────────────────────────────────────────

async function getLatestEpisodes(_page) {
  const $ = await getHomePage();
  const episodes = parseEpiItems($);
  // pagina futura: atualmente AniTube não pagina últimos episódios
  return enrichLatestEpisodeMetas(episodes);
}

async function getMostWatched(_page) {
  const $ = await getHomePage();
  const container = findContainerByKeywords($, ['mais vistos', 'ほとんど見た', 'populares']);
  if (container) {
    const items = parseAniItems($, $(container).find('.aniItem'));
    if (items.length > 0) return items;
  }
  // fallback: primeiro container (normalmente mais vistos)
  const first = $('.aniContainer').first().find('.aniItem');
  if (first.length) return parseAniItems($, first);
  return [];
}

async function getRecentAnimes(_page) {
  const $ = await getHomePage();
  const container = findContainerByKeywords($, ['recentes', '最近', 'lançamentos']);
  if (container) {
    const items = parseAniItems($, $(container).find('.aniItem'));
    if (items.length > 0) return items;
  }
  const containers = $('.aniContainer').toArray();
  if (containers.length >= 2) return parseAniItems($, $(containers[1]).find('.aniItem'));
  return [];
}

async function getAnimeList(page = 1) {
  const url = page === 1
    ? `${BASE_URL}/lista-de-animes-online/`
    : `${BASE_URL}/lista-de-animes-online/page/${page}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  return enrichWithTmdbPosters(parseAniItems($, $('div.aniItem')));
}

async function getAnimeListDubbed(page = 1) {
  const url = page === 1
    ? `${BASE_URL}/lista-de-animes-online/?genero=dublado`
    : `${BASE_URL}/lista-de-animes-online/page/${page}/?genero=dublado`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  return enrichWithTmdbPosters(parseAniItems($, $('div.aniItem')));
}

async function searchAnimes(query) {
  if (!query || !query.trim()) return [];
  const url = `${BASE_URL}/?s=${encodeURIComponent(query.trim())}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const aniResults = parseAniItems($, $('div.aniItem'));
  if (aniResults.length > 0) return aniResults;
  const epiResults = parseEpiItems($);
  // Se busca retornou episódios mas query parece ser nome de série, tenta limpar sufixo
  return epiResults;
}

async function searchEpisodeItems(query) {
  if (!query || !query.trim()) return [];
  const url = `${BASE_URL}/?s=${encodeURIComponent(query.trim())}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  return parseEpiItems($);
}

async function enrichLatestEpisodeMetas(items) {
  // Limita concorrência: 5 fetches paralelos no máximo
  const enriched = await Promise.all(items.map(item => limit(async () => {
    const episodeId = typeof item.id === 'string' ? item.id.replace('anitube:', '') : null;
    if (!episodeId) return item;
    const seriesId = await resolveSeriesIdFromEpisode(episodeId);
    if (!seriesId) return item;
    return makeLatestEpisodePreview(seriesId, episodeId, item.name, item.poster);
  })));

  const seen = new Set();
  return enriched.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

// Cache de mapeamento episódio -> série (evita re-fetch)
const seriesIdCache = new Map();
async function resolveSeriesIdFromEpisode(episodeId) {
  if (seriesIdCache.has(episodeId)) return seriesIdCache.get(episodeId);
  try {
    const html = await fetchHTML(`${BASE_URL}/${episodeId}b/`, 8000, 2);
    const $ = cheerio.load(html);
    // Tenta vários seletores
    const href =
      $('a.listaPagAni').first().attr('href') ||
      $('a[href*="/video/"]').first().attr('href') ||
      '';
    const id = extractId(href);
    if (id) seriesIdCache.set(episodeId, id);
    return id || null;
  } catch (_) {
    return null;
  }
}

async function getAnimeMeta(animeId) {
  const url = `${BASE_URL}/video/${animeId}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const rawTitle = $('h1').first().text().trim() ||
                   $('title').first().text().split('–')[0].split('-')[0].trim();
  const title = cleanTitle(rawTitle);
  const ogImage = $('meta[property="og:image"]').attr('content') || '';
  const poster = extractImgSrc($('#capaAnime img').first()) || extractImgSrc($('.capaAnime img').first()) || ogImage;
  const description =
    $('#sinopse2').text().trim() ||
    $('.sinopse').text().trim() ||
    $('meta[name="description"]').attr('content') ||
    '';

  const genres = [];
  let year = '';

  $('.boxAnimeSobre .boxAnimeSobreLinha').each((_, el) => {
    const text = $(el).text().trim();
    if (/^Gênero:/i.test(text)) {
      genres.push(...text.replace(/^Gênero:/i, '').split(',').map(s => s.trim()).filter(Boolean));
    } else if (/^Ano:/i.test(text)) {
      year = text.replace(/^Ano:/i, '').trim().match(/\d{4}/)?.[0] || text.replace(/^Ano:/i, '').trim();
    }
  });

  // Fallback: meta keywords como gêneros
  if (genres.length === 0) {
    const kw = $('meta[name="keywords"]').attr('content');
    if (kw) genres.push(...kw.split(',').slice(0, 5).map(s => s.trim()).filter(Boolean));
  }

  const videos = [];
  const seenEpIds = new Set();

  $('.pagAniListaContainer a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const epId = extractId(href);
    if (!epId || seenEpIds.has(epId)) return;
    seenEpIds.add(epId);

    const epTitle = $(el).attr('title') || $(el).text().trim() || `Episódio ${i + 1}`;
    const epNum = extractEpisodeNumber(epTitle) || (i + 1);

    videos.push({
      id: `anitube:${epId}`,
      title: `Episódio ${epNum}`,
      season: 1,
      episode: epNum,
      released: new Date(0).toISOString(),
    });
  });

  // Fallback: extrai episódios de outras listas possíveis
  if (videos.length === 0) {
    $('a[href*="b/"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (!/\/\d+b\//.test(href)) return;
      const epId = extractId(href);
      if (!epId || seenEpIds.has(epId)) return;
      // Evita pegar link da própria série
      if (epId === animeId) return;
      seenEpIds.add(epId);
      const epTitle = $(el).attr('title') || $(el).text().trim();
      if (!epTitle || epTitle.length > 80) return;
      const epNum = extractEpisodeNumber(epTitle) || videos.length + 1;
      videos.push({
        id: `anitube:${epId}`,
        title: `Episódio ${epNum}`,
        season: 1,
        episode: epNum,
        released: new Date(0).toISOString(),
      });
      if (videos.length >= 200) return false;
    });
  }

  if (videos.length === 0) {
    const epNum = extractEpisodeNumber(rawTitle) || 1;
    videos.push({
      id: `anitube:${animeId}`,
      title: `Episódio ${epNum}`,
      season: 1,
      episode: epNum,
      released: new Date(0).toISOString(),
    });
  }

  videos.sort((a, b) => a.episode - b.episode);

  return {
    meta: {
      id: `anitube:${animeId}`,
      type: 'series',
      name: title || `Anime ${animeId}`,
      poster,
      posterShape: 'poster',
      background: ogImage || poster,
      description,
      genres,
      year: year || undefined,
      website: url,
      videos,
    },
  };
}

async function getEpisodeIframes(epId) {
  const url = `${BASE_URL}/${epId}b/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const sources = [];

  $('div.pagEpiAbasItem').each((_, aba) => {
    const tabName = $(aba).text().trim() || 'Player';
    const tabTarget = $(aba).attr('aba-target');
    if (!tabTarget) return;
    const container = $(`div#${tabTarget}`);
    if (!container.length) return;
    const iframeSrc =
      container.find('iframe.metaframe').first().attr('src') ||
      container.find('iframe[src^="http"]').first().attr('src') ||
      container.find('iframe').first().attr('src');
    if (!iframeSrc) return;
    sources.push({ name: tabName, iframeSrc, containerId: tabTarget });
  });

  // Fallback: iframes soltos
  if (sources.length === 0) {
    $('iframe').each((i, el) => {
      const src = $(el).attr('src');
      if (src && src.startsWith('http')) {
        sources.push({ name: `Player ${i + 1}`, iframeSrc: src, containerId: `fallback-${i}` });
      }
    });
  }

  return { sources, episodeUrl: url };
}

// ───────────────────────────────────────────────────────────────────────────
// TMDB — enriquecimento de capas
// ───────────────────────────────────────────────────────────────────────────

const TMDB_KEY = config.tmdbApiKey;
const TMDB_IMG_BASE = config.tmdb.imageBase;
const _tmdbCache = new Map(); // key -> { poster, expires }

async function fetchTmdbPoster(name) {
  if (!TMDB_KEY) return null;
  const key = name.toLowerCase().trim();
  const now = Date.now();
  const cached = _tmdbCache.get(key);
  if (cached && cached.expires > now) return cached.poster;

  try {
    const url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(key)}&language=pt-BR`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      _tmdbCache.set(key, { poster: null, expires: now + 10 * 60 * 1000 }); // cache negativo 10min
      return null;
    }
    const data = await res.json();
    const result = (data.results || []).find(r => r.poster_path) || null;
    const poster = result ? `${TMDB_IMG_BASE}${result.poster_path}` : null;
    _tmdbCache.set(key, { poster, expires: now + config.tmdb.cacheTtlMs });
    // LRU cap
    if (_tmdbCache.size > 500) _tmdbCache.delete(_tmdbCache.keys().next().value);
    return poster;
  } catch (_) {
    return null;
  }
}

async function enrichWithTmdbPosters(items) {
  if (!TMDB_KEY) return items;
  if (!items.length) return items;
  return Promise.all(items.map(item => limit(async () => {
    const tmdbPoster = await fetchTmdbPoster(item.name);
    return tmdbPoster ? { ...item, poster: tmdbPoster } : item;
  })));
}

// ───────────────────────────────────────────────────────────────────────────
// EXPORTS
// ───────────────────────────────────────────────────────────────────────────
module.exports = {
  getLatestEpisodes,
  getMostWatched,
  getRecentAnimes,
  getAnimeList,
  getAnimeListDubbed,
  searchAnimes,
  searchEpisodeItems,
  getAnimeMeta,
  getEpisodeIframes,
  enrichWithTmdbPosters,
  extractId,
  cleanTitle,
  extractEpisodeNumber,
  fetchHTML,
  BASE_URL,
  BASES,
};
