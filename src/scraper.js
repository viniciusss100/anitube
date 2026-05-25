'use strict';

/**
 * Scraper para AniTube.news — v3.2.7
 */

const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.anitube.zip';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

const FETCH_HEADERS = {
  'User-Agent'      : UA,
  'Accept'          : 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language' : 'pt-BR,pt;q=0.9',
  'Referer'         : BASE_URL + '/',
};

// ───────────────────────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────────────────────

/**
 * Busca HTML com retry automático (3 tentativas, backoff de 1 s).
 * @param {string} url
 * @param {number} [timeout=15000]
 * @param {number} [retries=3]
 */
async function fetchHTML(url, timeout = 15000, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = attempt * 1000;
      console.warn(`[fetchHTML] Retry ${attempt}/${retries} para ${url}`);
      await new Promise(r => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ───────────────────────────────────────────────────────────────────────────

/** Extrai o ID numérico de uma URL do AniTube. */
function extractId(url) {
  if (!url || typeof url !== 'string') return null;
  let m = url.match(/\/video\/(\d+)\/?/);
  if (m) return m[1];
  m = url.match(/\/(\d{4,})b/);
  if (m) return m[1];
  return null;
}

/** Limpa o título removendo sufixos de episódio e entidades HTML. */
function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\s*[–\-]\s*Todos os Epis.+$/i, '')
    .replace(/\s*[–\-]\s*Epis[oó]dio\s*\d+.*$/i, '')
    .replace(/\s*[–\-]\s*Epis[oó]dios.*$/i, '')
    .replace(/&#8211;/g, '–')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Tenta extrair o número do episódio a partir do título. */
function extractEpisodeNumber(title) {
  if (!title) return null;
  const patterns = [
    /Epis[oó]dio\s*(\d+)/i,
    /Ep\.?\s*(\d+)/i,
    /\bE(\d+)\b/i,
    /\b(\d{3,})\b/,
    /\b(\d{1,2})\b/,
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Constrói um objeto meta mínimo (preview de catálogo).
 * Garante `poster` como string válida (nunca undefined).
 */
function makeMetaPreview(id, name, poster) {
  return {
    id          : `anitube:${id}`,
    type        : 'series',
    name        : cleanTitle(name),
    poster      : poster || '',
    posterShape : 'poster',
  };
}

function makeLatestEpisodePreview(seriesId, episodeId, name, poster) {
  const seriesName = cleanTitle(name);
  return {
    id          : `anitube:${seriesId}`,
    type        : 'series',
    name        : seriesName,
    description : name,
    poster      : poster || '',
    posterShape : 'poster',
    behaviorHints: {
      defaultVideoId: `anitube:${episodeId}`,
    },
  };
}

/**
 * Extrai a imagem preferindo `src` mas fazendo fallback para
 * `data-src` (lazy-load) e depois `data-lazy-src`.
 */
function extractImgSrc($el) {
  return (
    $el.attr('src') ||
    $el.attr('data-src') ||
    $el.attr('data-lazy-src') ||
    ''
  );
}

// ───────────────────────────────────────────────────────────────────────────
// PARSERS
// ───────────────────────────────────────────────────────────────────────────

function parseAniItems($, $elements) {
  const results = [];
  const seen    = new Set();
  $elements.each((_, el) => {
    const $a   = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id   = extractId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name   = $a.attr('title') || $(el).find('.aniItemNome').first().text().trim();
    const poster = extractImgSrc($(el).find('img').first());
    if (!name) return;
    results.push(makeMetaPreview(id, name, poster));
  });
  return results;
}

function parseEpiItems($) {
  const results = [];
  const seen    = new Set();
  $('div.epiItem').each((_, el) => {
    const $a   = $(el).find('a').first();
    const href = $a.attr('href') || '';
    const id   = extractId(href);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rawName = ($a.attr('title') || $(el).find('.epiItemNome').first().text()).trim();
    const poster  = extractImgSrc($(el).find('img').first());
    if (!rawName) return;
    results.push({
      id          : `anitube:${id}`,
      type        : 'series',
      name        : rawName,
      poster,
      posterShape : 'poster',
    });
  });
  return results;
}

/**
 * Percorre os `.aniContainer` e retorna o que contém algum dos `keywords`
 * no título, ou `null` se nenhum for encontrado.
 * @param {CheerioStatic} $
 * @param {string[]} keywords
 */
function findContainerByKeywords($, keywords) {
  let found = null;
  $('.aniContainer').each((_, container) => {
    if (found) return false; // break
    const title = $(container).find('.aniContainerTitulo').first().text().toLowerCase();
    if (keywords.some(k => title.includes(k.toLowerCase()))) {
      found = container;
    }
  });
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// SCRAPING – HOME (compartilhado entre getLatest / getMostWatched / getRecent)
// ───────────────────────────────────────────────────────────────────────────

/** Cache interno da home para evitar 3 GETs na mesma renderização. */
let _homeCache    = null;
let _homeCacheTs  = 0;
const HOME_TTL_MS = 60 * 1000; // 1 min

async function getHomePage() {
  if (_homeCache && Date.now() - _homeCacheTs < HOME_TTL_MS) return _homeCache;
  _homeCache   = cheerio.load(await fetchHTML(BASE_URL + '/'));
  _homeCacheTs = Date.now();
  return _homeCache;
}

// ───────────────────────────────────────────────────────────────────────────
// FUNÇÕES PÚBLICAS
// ───────────────────────────────────────────────────────────────────────────

/** @param {number} [_page] reservado para compatibilidade futura */
async function getLatestEpisodes(_page) {
  const $ = await getHomePage();
  const episodes = parseEpiItems($);
  return enrichLatestEpisodeMetas(episodes);
}

/** @param {number} [_page] reservado para compatibilidade futura */
async function getMostWatched(_page) {
  const $ = await getHomePage();
  const container = findContainerByKeywords($, ['mais vistos', 'ほとんど見た']);
  if (container) {
    const items = parseAniItems($, $(container).find('.aniItem'));
    if (items.length > 0) return items;
  }
  return parseAniItems($, $('.aniContainer').first().find('.aniItem'));
}

/** @param {number} [_page] reservado para compatibilidade futura */
async function getRecentAnimes(_page) {
  const $ = await getHomePage();
  const container = findContainerByKeywords($, ['recentes', '最近']);
  if (container) {
    const items = parseAniItems($, $(container).find('.aniItem'));
    if (items.length > 0) return items;
  }
  const containers = $('.aniContainer').toArray();
  if (containers.length >= 2) return parseAniItems($, $(containers[1]).find('.aniItem'));
  return [];
}

async function getAnimeList(page = 1) {
  const url  = page === 1
    ? `${BASE_URL}/lista-de-animes-online/`
    : `${BASE_URL}/lista-de-animes-online/page/${page}/`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  return enrichWithTmdbPosters(parseAniItems($, $('div.aniItem')));
}

async function getAnimeListDubbed(page = 1) {
  const url  = page === 1
    ? `${BASE_URL}/lista-de-animes-online/?genero=dublado`
    : `${BASE_URL}/lista-de-animes-online/page/${page}/?genero=dublado`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  return enrichWithTmdbPosters(parseAniItems($, $('div.aniItem')));
}

async function searchAnimes(query) {
  if (!query || !query.trim()) return [];
  const url  = `${BASE_URL}/?s=${encodeURIComponent(query.trim())}`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  const aniResults = parseAniItems($, $('div.aniItem'));
  if (aniResults.length > 0) return aniResults;
  return parseEpiItems($);
}

async function searchEpisodeItems(query) {
  if (!query || !query.trim()) return [];
  const url  = `${BASE_URL}/?s=${encodeURIComponent(query.trim())}`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  return parseEpiItems($);
}

async function enrichLatestEpisodeMetas(items) {
  const enriched = await Promise.all(items.map(async item => {
    const episodeId = typeof item.id === 'string' ? item.id.replace('anitube:', '') : null;
    if (!episodeId) return item;

    const seriesId = await resolveSeriesIdFromEpisode(episodeId);
    if (!seriesId) return item;

    return makeLatestEpisodePreview(seriesId, episodeId, item.name, item.poster);
  }));

  const seen = new Set();
  return enriched.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function resolveSeriesIdFromEpisode(episodeId) {
  try {
    const html = await fetchHTML(`${BASE_URL}/${episodeId}b/`);
    const $ = cheerio.load(html);
    const href = $('a.listaPagAni').first().attr('href') || '';
    return extractId(href);
  } catch (_) {
    return null;
  }
}

async function getAnimeMeta(animeId) {
  const url  = `${BASE_URL}/video/${animeId}/`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);

  const rawTitle = $('h1').first().text().trim() ||
                   $('title').first().text().split('–')[0].trim();
  const title      = cleanTitle(rawTitle);
  const ogImage    = $('meta[property="og:image"]').attr('content') || '';
  const poster     = extractImgSrc($('#capaAnime img').first()) || ogImage;
  const description =
    $('#sinopse2').text().trim() ||
    $('meta[name="description"]').attr('content') ||
    '';

  const genres = [];
  let year = '';

  $('.boxAnimeSobre .boxAnimeSobreLinha').each((_, el) => {
    const text = $(el).text().trim();
    if (text.startsWith('Gênero:')) {
      genres.push(
        ...text.replace('Gênero:', '').split(',').map(s => s.trim()).filter(Boolean)
      );
    } else if (text.startsWith('Ano:')) {
      year = text.replace('Ano:', '').trim();
    }
  });

  const videos    = [];
  const seenEpIds = new Set();

  $('.pagAniListaContainer a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const epId = extractId(href);
    if (!epId || seenEpIds.has(epId)) return;
    seenEpIds.add(epId);

    const epTitle = $(el).attr('title') || $(el).text().trim() || `Episódio ${i + 1}`;
    const matchNum = epTitle.match(/\b(\d+)\b/);
    const epNum   = extractEpisodeNumber(epTitle) ||
                    (matchNum ? parseInt(matchNum[1], 10) : i + 1);

    videos.push({
      id       : `anitube:${epId}`,
      title    : `Episódio ${epNum}`,
      season   : 1,
      episode  : epNum,
      released : new Date(0).toISOString(),
    });
  });

  // Fallback: página de episódio único
  if (videos.length === 0) {
    const epNum = extractEpisodeNumber(rawTitle) || 1;
    videos.push({
      id       : `anitube:${animeId}`,
      title    : `Episódio ${epNum}`,
      season   : 1,
      episode  : epNum,
      released : new Date(0).toISOString(),
    });
  }

  videos.sort((a, b) => a.episode - b.episode);

  return {
    meta: {
      id          : `anitube:${animeId}`,
      type        : 'series',
      name        : title,
      poster,
      posterShape : 'poster',
      background  : ogImage || poster,
      description,
      genres,
      year        : year || undefined,
      website     : url,
      videos,
    },
  };
}

async function getEpisodeIframes(epId) {
  const url  = `${BASE_URL}/${epId}b/`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  const sources = [];

  $('div.pagEpiAbasItem').each((_, aba) => {
    const tabName   = $(aba).text().trim() || 'Player';
    const tabTarget = $(aba).attr('aba-target');
    if (!tabTarget) return;

    const container = $(`div#${tabTarget}`);
    if (!container.length) return;

    const iframeSrc =
      container.find('iframe.metaframe').first().attr('src') ||
      container.find('iframe[src^="http"]').first().attr('src');

    if (!iframeSrc) return;
    sources.push({ name: tabName, iframeSrc, containerId: tabTarget });
  });

  return { sources, episodeUrl: url };
}

// ───────────────────────────────────────────────────────────────────────────
// TMDB — enriquecimento de capas
// ───────────────────────────────────────────────────────────────────────────

const TMDB_KEY      = process.env.TMDB_API_KEY || '';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w500';

// Cache simples para evitar requisições repetidas ao TMDB
const _tmdbCache = new Map();

async function fetchTmdbPoster(name) {
  if (!TMDB_KEY) return null;
  const key = name.toLowerCase().trim();
  if (_tmdbCache.has(key)) return _tmdbCache.get(key);

  try {
    const url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(key)}&language=pt-BR`;
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res   = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data    = await res.json();
    const result  = (data.results || []).find(r => r.poster_path) || null;
    const poster  = result ? `${TMDB_IMG_BASE}${result.poster_path}` : null;
    _tmdbCache.set(key, poster);
    return poster;
  } catch (_) {
    return null;
  }
}

async function enrichWithTmdbPosters(items) {
  if (!TMDB_KEY) return items;
  return Promise.all(items.map(async item => {
    const tmdbPoster = await fetchTmdbPoster(item.name);
    return tmdbPoster ? { ...item, poster: tmdbPoster } : item;
  }));
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
  // utilitários exportados para testes unitários
  extractId,
  cleanTitle,
  extractEpisodeNumber,
  fetchHTML,
  BASE_URL,
};
