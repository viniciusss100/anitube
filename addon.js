'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper = require('./src/scraper');
const { extractStreams } = require('./src/extractor');
const fetch = require('node-fetch');
const config = require('./src/config');
const logger = require('./src/logger');
const cache = require('./src/cache');

const log = logger.child('addon');

// Headers compartilhados
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  Referer: `${config.kitsuBaseUrl}/`,
  Origin: config.kitsuBaseUrl,
};

const KITSU_BASE_URL = config.kitsuBaseUrl;

// Helper fetchJson robusto com AbortController + retry
async function fetchJson(url, headers = {}, timeout = config.http.timeoutMs, retries = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { headers: { ...BROWSER_HEADERS, ...headers }, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.json();
    } catch (err) {
      lastErr = err;
      const isAbort = err.name === 'AbortError';
      if (attempt < retries) {
        const wait = attempt * 300 + Math.floor(Math.random() * 200);
        log.warn(`fetchJson retry ${attempt}/${retries} ${url} (${isAbort ? 'timeout' : err.message}) wait ${wait}ms`);
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

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifest = {
  id: 'community.anitube.news',
  version: '4.3.0',
  name: '🎌 AniTube.news',
  description: 'Animes dublados e legendados do AniTube.news. Catálogos, busca e streams HLS via proxy local. Integra com Cinemeta e Kitsu.',
  logo: 'https://www.anitube.zip/wp-content/uploads/2021/08/cropped-aniTube-512x512-1.png',
  background: 'https://www.anitube.zip/wp-content/uploads/2021/08/aniTube-bg.jpg',

  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  // 'anime' mantido por compatibilidade mas Stremio oficial usa 'series'/'movie'
  catalogs: [
    {
      id: 'anitube_ultimos',
      type: 'series',
      name: '🆕 AniTube – Últimos Episódios',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    },
    {
      id: 'anitube_recentes',
      type: 'series',
      name: '📅 AniTube – Animes Recentes',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id: 'anitube_mais_vistos',
      type: 'series',
      name: '🔥 AniTube – Mais Vistos',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id: 'anitube_dublados',
      type: 'series',
      name: '🎙️ AniTube – Dublados',
      extra: [{ name: 'skip', isRequired: false }],
    },
  ],

  idPrefixes: ['anitube:', 'tt', 'kitsu', 'kitsu:', 'mal', 'mal:', 'anilist', 'anilist:', 'anidb', 'anidb:'],

  behaviorHints: { configurable: true, configurationRequired: false, adult: false },
};

const builder = new addonBuilder(manifest);

// Validação simples
function parseSkip(extra) {
  const n = parseInt(extra?.skip, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function parsePage(skip) {
  return Math.floor(skip / 20) + 1;
}

// ── Catalog Handler ───────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ id, extra = {}, type }) => {
  // Stremio pode chamar com type='anime' legado; normaliza
  if (type && type !== 'series' && type !== 'anime') return { metas: [] };

  const skip = parseSkip(extra);
  const page = parsePage(skip);
  const search = (extra.search || '').trim().slice(0, 80);

  const key = `cat:${id}:${search}:${page}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    let metas = [];

    if (search) {
      metas = await scraper.searchAnimes(search);
      // aplica paginação local se search não pagina no site
      if (metas.length > 20) metas = metas.slice(skip, skip + 20);
    } else {
      switch (id) {
        case 'anitube_ultimos': metas = await scraper.getLatestEpisodes(page); break;
        case 'anitube_mais_vistos': metas = await scraper.getMostWatched(page); break;
        case 'anitube_recentes': metas = await scraper.getRecentAnimes(page); break;
        case 'anitube_dublados': metas = await scraper.getAnimeListDubbed(page); break;
        case 'anitube_lista':
        default: metas = await scraper.getAnimeList(page); break;
      }
    }

    if (!Array.isArray(metas)) metas = [];
    // Garante shape mínimo Stremio
    metas = metas.filter(m => m && m.id && m.name).slice(0, 40);

    const result = { metas, cacheMaxAge: 300 };
    cache.set(key, result, 60_000);
    return result;
  } catch (e) {
    log.error(`[Catalog] "${id}" page=${page} search="${search}": ${e.message}`);
    return { metas: [] };
  }
});

// ── Meta Handler ──────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ id, type }) => {
  if (type && type !== 'series' && type !== 'anime') return { meta: {} };
  if (!id || typeof id !== 'string' || !id.startsWith('anitube:')) return { meta: {} };

  const key = `meta:${id}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const animeId = id.replace('anitube:', '');
    if (!/^\d+$/.test(animeId)) return { meta: {} };
    const result = await scraper.getAnimeMeta(animeId);
    if (!result?.meta) return { meta: {} };
    cache.set(key, result, 5 * 60 * 1000);
    return result;
  } catch (e) {
    log.error(`[Meta] "${id}": ${e.message}`);
    return { meta: {} };
  }
});

// ── Stream Handler ────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ id, type }) => {
  if (!id || typeof id !== 'string') return { streams: [] };
  if (type === 'movie') return { streams: [] };

  const key = `stream:${id}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    let streams = [];

    if (id.startsWith('anitube:')) {
      const epId = id.replace('anitube:', '');
      if (!/^\d+$/.test(epId)) return { streams: [] };
      streams = await extractAniTubeById(epId);
    } else if (id.startsWith('tt')) {
      const parts = id.split(':');
      const imdbId = parts[0];
      if (!/^tt\d+$/.test(imdbId)) return { streams: [] };
      const season = parts[1] ? parseInt(parts[1], 10) : 1;
      const episode = parts[2] ? parseInt(parts[2], 10) : null;

      const meta = await resolveImdbTitle(imdbId);
      if (meta.title && isLikelyAnimeMeta(meta)) {
        const enriched = await enrichWithKitsuAliases(meta, imdbId);
        streams = await searchBothVersions(enriched.title, enriched.aliases, season, episode);
      } else if (meta.title) {
        log.info(`[Stream] ${id} não parece anime (genres=${meta.genres.join(',')}) ignorado`);
      }
    } else if (id.startsWith('kitsu:') || id.startsWith('mal:') || id.startsWith('anilist:') || id.startsWith('anidb:')) {
      const parts = id.split(':');
      const provider = parts[0];
      const seriesId = parts[1];
      if (!seriesId) return { streams: [] };
      const externalId = `${provider}:${seriesId}`;

      let season = 1;
      let episode = null;
      if (parts.length === 4) {
        season = parseInt(parts[2], 10) || 1;
        episode = parseInt(parts[3], 10) || null;
      } else if (parts.length === 3) {
        episode = parseInt(parts[2], 10) || null;
      }

      const { title, aliases } = await resolveKitsuTitle(externalId);
      if (title) streams = await searchBothVersions(title, aliases, season, episode);
    }

    if (!streams.length) return { streams: [] };
    // Ordena: Dublado primeiro, depois Legendado, depois qualidade (FHD > HD)
    streams.sort((a, b) => {
      const dubA = a.name.includes('[Dublado]') ? 0 : 1;
      const dubB = b.name.includes('[Dublado]') ? 0 : 1;
      if (dubA !== dubB) return dubA - dubB;
      const q = { '1080p': 0, '720p': 1, '480p': 2 };
      const qa = Object.keys(q).find(k => a.description.includes(k)) || '480p';
      const qb = Object.keys(q).find(k => b.description.includes(k)) || '480p';
      return q[qa] - q[qb];
    });

    const result = { streams, cacheMaxAge: 300 };
    cache.set(key, result, 2 * 60 * 1000);
    return result;
  } catch (e) {
    log.error(`[Stream] "${id}": ${e.stack || e.message}`);
    return { streams: [] };
  }
});

// ── Extração de streams ───────────────────────────────────────────────────────

async function extractAniTubeById(epId) {
  const sr = await scraper.getEpisodeIframes(epId);
  if (!sr?.sources?.length) return [];
  return extractStreams(sr.sources, sr.episodeUrl);
}

async function resolveImdbTitle(imdbId) {
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, { timeout: 8000 });
    if (!r.ok) return { title: null, aliases: [], genres: [], countries: [], description: '' };
    const j = await r.json();
    const meta = j?.meta || {};
    return {
      title: meta.name || null,
      aliases: Array.isArray(meta.aliases) ? meta.aliases.filter(a => typeof a === 'string') : [],
      genres: normalizeToArray(meta.genres || meta.genre || []),
      countries: normalizeToArray(meta.countries || meta.country || []),
      description: meta.description || '',
    };
  } catch (_) {
    return { title: null, aliases: [], genres: [], countries: [], description: '' };
  }
}

async function enrichWithKitsuAliases(meta, imdbId) {
  const aliases = Array.isArray(meta?.aliases) ? meta.aliases.filter(a => typeof a === 'string') : [];
  if (aliases.length > 0) return { title: meta.title, aliases };
  try {
    const j = await fetchJson(`${KITSU_BASE_URL}/catalog/series/kitsu-anime-list/search=${encodeURIComponent(meta.title)}.json`);
    const match = (j?.metas || []).find(item => item?.imdb_id === imdbId)
      || (j?.metas || []).find(item => normalize(item?.name || '') === normalize(meta.title));
    if (!match) return { title: meta.title, aliases };
    const enrichedAliases = Array.isArray(match.aliases) ? match.aliases.filter(a => typeof a === 'string') : [];
    return {
      title: match.name || meta.title,
      aliases: enrichedAliases.length ? enrichedAliases : aliases,
    };
  } catch (_) {
    return { title: meta.title, aliases };
  }
}

async function resolveKitsuTitle(externalId) {
  try {
    const j = await fetchJson(`${KITSU_BASE_URL}/meta/anime/${externalId}.json`);
    const title = j?.meta?.name || null;
    if (title) return { title, aliases: Array.isArray(j?.meta?.aliases) ? j.meta.aliases : [] };
  } catch (_) {}

  if (externalId.startsWith('kitsu:')) {
    const kitsuId = externalId.replace('kitsu:', '');
    if (!/^\d+$/.test(kitsuId)) return { title: null, aliases: [] };
    try {
      const r = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 8000, headers: { Accept: 'application/vnd.api+json' } });
      if (r.ok) {
        const j = await r.json();
        const attrs = j?.data?.attributes || {};
        const title = attrs.canonicalTitle || attrs.titles?.en || attrs.titles?.en_jp || null;
        const aliases = Object.values(attrs.titles || {}).filter(t => typeof t === 'string' && t !== title);
        if (attrs.abbreviatedTitles) aliases.push(...attrs.abbreviatedTitles);
        if (title) return { title, aliases };
      }
    } catch (_) {}
  }

  log.warn(`[Kitsu] Falha ao resolver ${externalId}`);
  return { title: null, aliases: [] };
}

// ── Busca com verificação de relevância ───────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.45;
const EPISODE_FALLBACK_THRESHOLD = 0.35;

async function searchAndExtract(title, aliases, season, episode) {
  const match = await findBestMatch(buildQueries(title, aliases), buildAllTitles(title, aliases), SIMILARITY_THRESHOLD);
  if (!match) {
    log.warn(`[AniTube] Sem match confiável para "${title}"`);
    return episode ? searchEpisodeDirect(title, aliases, season, episode) : [];
  }
  log.info(`[AniTube] Match: "${match.name}" (score: ${match.score.toFixed(2)})`);
  const epId = await resolveEpisodeId(match.id.replace('anitube:', ''), season, episode);
  if (!epId) return episode ? searchEpisodeDirect(title, aliases, season, episode) : [];
  const streams = await extractAniTubeById(epId);
  if (streams.length || !episode) return streams;
  return searchEpisodeDirect(title, aliases, season, episode);
}

async function searchBothVersions(title, aliases, season, episode) {
  const queries = buildQueries(title, aliases);
  const allTitles = buildAllTitles(title, aliases);

  const seen = new Set();
  const candidates = [];
  for (const q of queries) {
    let results;
    try { results = await scraper.searchAnimes(q); } catch (_) { continue; }
    for (const c of (results || [])) {
      if (!seen.has(c.id)) { seen.add(c.id); candidates.push(c); }
    }
    // early break se já temos dublado + legendado com bom score
    if (candidates.length >= 20) break;
  }

  let dubMatch = null; let dubScore = 0;
  let legMatch = null; let legScore = 0;

  for (const c of candidates) {
    const isDub = /\b(dub(lado)?|dublado)\b/i.test(c.name || '');
    const isLeg = /\b(leg(endado)?|legendado)\b/i.test(c.name || '');
    const nameForScore = (c.name || '').replace(/\s*[\(\[]?\s*(dublado|legendado|dub|leg)\s*[\)\]]?/gi, '').trim();
    const score = allTitles.reduce((max, t) => Math.max(max, similarity(t, nameForScore)), 0);
    if (isDub && score > dubScore) { dubScore = score; dubMatch = c; }
    if ((isLeg || (!isDub && !isLeg)) && score > legScore) { legScore = score; legMatch = c; }
  }

  const results = [];
  async function extractLabeled(match, score, label) {
    if (!match || score < SIMILARITY_THRESHOLD) return;
    const epId = await resolveEpisodeId(match.id.replace('anitube:', ''), season, episode);
    if (!epId) return;
    const streams = await extractAniTubeById(epId);
    for (const s of streams) results.push({ ...s, name: `${s.name} [${label}]` });
  }

  await Promise.all([
    extractLabeled(dubMatch, dubScore, 'Dublado'),
    extractLabeled(legMatch, legScore, 'Legendado'),
  ]);

  if (!results.length) return searchAndExtract(title, aliases, season, episode);
  return results;
}

async function findBestMatch(queries, allTitles, threshold) {
  let bestMatch = null;
  let bestScore = 0;
  let bestIsDub = false;

  for (const q of queries) {
    let results;
    try { results = await scraper.searchAnimes(q); } catch (_) { continue; }
    if (!results?.length) continue;

    for (const candidate of results) {
      const candidateName = candidate.name || '';
      const isDub = /\b(dub(lado)?|dublado)\b/i.test(candidateName);
      const nameForScore = candidateName.replace(/\s*[\(\[]?\s*(dublado|legendado|dub|leg)\s*[\)\]]?/gi, '').trim();
      const score = allTitles.reduce((max, t) => Math.max(max, similarity(t, nameForScore)), 0);
      if (score > bestScore || (score === bestScore && isDub && !bestIsDub)) {
        bestScore = score; bestMatch = candidate; bestIsDub = isDub;
      }
    }
    if (bestScore >= threshold + 0.15) break; // match muito bom
    if (bestScore >= threshold) break;
  }

  if (!bestMatch || bestScore < threshold) return null;
  return { ...bestMatch, score: bestScore };
}

async function searchEpisodeDirect(title, aliases, season, episode) {
  const queries = buildEpisodeQueries(title, aliases, episode);
  const allTitles = buildAllTitles(title, aliases);

  let bestMatch = null;
  let bestScore = 0;
  let bestIsDub = false;
  let matchedQuery = '';

  for (const q of queries) {
    let results;
    try { results = await scraper.searchAnimes(q); } catch (_) { continue; }
    if (!results?.length) continue;

    for (const candidate of results) {
      const rawName = candidate.name || '';
      const isDub = /\b(dub(lado)?|dublado)\b/i.test(rawName);
      const nameForScore = scraper.cleanTitle(rawName.replace(/\s*[\(\[]?\s*(dublado|legendado|dub|leg)\s*[\)\]]?/gi, '').trim());
      const score = allTitles.reduce((max, t) => Math.max(max, similarity(t, nameForScore)), 0);

      if (looksLikeEpisodeResult(rawName)) {
        const candidateEpisode = extractEpisodeFromName(rawName);
        if (candidateEpisode !== episode) continue;
      } else {
        if (!isSeasonCompatible(rawName, season)) continue;
      }

      if (score > bestScore || (score === bestScore && isDub && !bestIsDub)) {
        bestScore = score; bestMatch = candidate; bestIsDub = isDub; matchedQuery = q;
      }
    }
    if (bestScore >= EPISODE_FALLBACK_THRESHOLD + 0.2) break;
    if (bestScore >= EPISODE_FALLBACK_THRESHOLD) break;
  }

  if (!bestMatch || bestScore < EPISODE_FALLBACK_THRESHOLD) {
    log.warn(`[AniTube] Sem match de episódio para "${title}" ep ${episode} (melhor score: ${bestScore.toFixed(2)})`);
    return [];
  }

  log.info(`[AniTube] Match direto ep: "${matchedQuery}" → "${bestMatch.name}" (score: ${bestScore.toFixed(2)})`);

  if (looksLikeEpisodeResult(bestMatch.name)) {
    return extractAniTubeById(bestMatch.id.replace('anitube:', ''));
  }

  const animeId = bestMatch.id.replace('anitube:', '');
  const epId = await resolveEpisodeId(animeId, season, episode);
  if (!epId) return [];
  return extractAniTubeById(epId);
}

async function resolveEpisodeId(animeId, season, episode) {
  if (!episode || episode <= 0) return animeId;
  try {
    const meta = await scraper.getAnimeMeta(animeId);
    const videos = meta?.meta?.videos || [];
    if (!videos.length) return animeId;
    const ep = videos.find(v => v.season === season && v.episode === episode)
            || videos.find(v => v.episode === episode);
    return ep ? ep.id.replace('anitube:', '') : null;
  } catch (_) {
    return animeId;
  }
}

function buildQueries(title, aliases) {
  const seen = new Set();
  const jpFirst = [];
  const enLast = [];
  function addTo(arr, s) {
    if (!s || s.length < 2) return;
    const clean = s.trim();
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    arr.push(clean);
  }
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (typeof a !== 'string') continue;
      addTo(jpFirst, a.split(':')[0].split(' - ')[0].trim());
      addTo(jpFirst, a.trim());
    }
  }
  const baseTitle = title.replace(/\s*\(Dub\)/i, '').trim();
  addTo(enLast, baseTitle.split(':')[0].split(' - ')[0].trim());
  addTo(enLast, baseTitle);
  addTo(enLast, title);
  return [...jpFirst, ...enLast].slice(0, 8); // limita 8 queries
}

function buildEpisodeQueries(title, aliases, episode) {
  const seen = new Set();
  const queries = [];
  function add(query) {
    const clean = (query || '').trim();
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    queries.push(clean);
  }
  for (const base of buildQueries(title, aliases)) {
    add(`${base} ${episode}`);
    add(`${base} episódio ${episode}`);
    add(`${base} ep ${episode}`);
    add(base);
  }
  return queries.slice(0, 15);
}

function buildAllTitles(title, aliases) {
  const titles = new Set();
  function add(s) {
    if (s && s.length > 1) titles.add(normalize(s));
  }
  add(title);
  add(title.replace(/\s*\(Dub\)/i, '').trim());
  add(title.split(':')[0].trim());
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (typeof a === 'string') { add(a); add(a.split(':')[0].trim()); }
    }
  }
  return [...titles];
}

function extractEpisodeFromName(name) {
  const value = scraper.extractEpisodeNumber(name || '');
  return Number.isInteger(value) ? value : null;
}

function looksLikeEpisodeResult(name) {
  const text = name || '';
  return /epis[oó]dio|ep\.?\s*\d+/i.test(text) && !/todos os epis/i.test(text);
}

function isSeasonCompatible(name, season) {
  const text = normalize(name || '');
  if (!season || season <= 1) {
    // Bloqueia S2+ explícito
    return !/\b(season|temporada|part|cour)\s*([2-9]\d*)\b/.test(text)
        && !/\b(2nd|3rd|4th)\s*season\b/.test(text);
  }
  // Season >=2: precisa mencionar número
  return text.includes(` ${season}`)
    || text.includes(`season ${season}`)
    || text.includes(`temporada ${season}`)
    || text.includes(`part ${season}`)
    || text.includes(`cour ${season}`)
    || new RegExp(`\\bs0*${season}\\b`).test(text);
}

function isLikelyAnimeMeta(meta) {
  const genres = Array.isArray(meta?.genres) ? meta.genres.map(normalize) : [];
  const countries = Array.isArray(meta?.countries) ? meta.countries.map(normalize) : [];
  const description = normalize(meta?.description || '');
  if (genres.some(g => g.includes('anime') || g.includes('animacao') || g.includes('animation') || g.includes('manga'))) return true;
  if (countries.some(c => c.includes('japan') || c.includes('japao') || c === 'jp')) return true;
  if (description.includes('anime') || description.includes('japanese animation')) return true;
  // Heurística: se tem genres vazios mas title japonês, assume true para não bloquear falso-negativo
  if (genres.length === 0 && countries.length === 0) return true;
  return false;
}

function normalizeToArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
  return [];
}

function normalize(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[:\-–—]/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\b(the|a|an|no|wo|wa|ga|de|ni|to|da|do|das|dos|e|o|os|as)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length) * 0.95;
  }
  const setA = new Set(na.split(' ').filter(Boolean));
  const setB = new Set(nb.split(' ').filter(Boolean));
  let wordInter = 0;
  for (const w of setA) if (setB.has(w)) wordInter++;
  const jaccard = setA.size + setB.size > wordInter ? wordInter / (setA.size + setB.size - wordInter) : 0;
  const bgA = new Set(bigrams(na));
  const bgB = new Set(bigrams(nb));
  let bgInter = 0;
  for (const bg of bgA) if (bgB.has(bg)) bgInter++;
  const dice = (bgA.size + bgB.size) > 0 ? (2 * bgInter) / (bgA.size + bgB.size) : 0;
  // Combina com peso
  return Math.max(jaccard * 0.9 + dice * 0.1, dice * 0.85);
}

function bigrams(s) {
  const words = s.split(' ').filter(Boolean);
  if (words.length === 1) {
    // char bigrams para título único
    const w = words[0];
    if (w.length <= 3) return [w];
    const out = [];
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    return out;
  }
  const out = [];
  for (let i = 0; i < words.length - 1; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

module.exports = builder.getInterface();
module.exports._manifest = manifest;
module.exports._testables = { normalize, similarity, isSeasonCompatible, buildQueries, buildAllTitles };
