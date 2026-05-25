'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const scraper = require('./src/scraper');
const { extractStreams } = require('./src/extractor');
const fetch = require('node-fetch');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Referer': 'https://kitsufortheweebs.midnightignite.me/',
  'Origin': 'https://kitsufortheweebs.midnightignite.me',
};

const KITSU_BASE_URL = 'https://kitsufortheweebs.midnightignite.me';

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, {
    timeout: 8000,
    headers: { ...BROWSER_HEADERS, ...headers },
  });

  if (!r.ok) {
    throw new Error(`HTTP ${r.status} for ${url}`);
  }

  return r.json();
}

// ── Cache em memória ──────────────────────────────────────────────────────────
const cache     = new Map();
const CACHE_TTL = 2 * 60 * 1000; // 2 min

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifest = {
  id         : 'community.anitube.news',
  version    : '4.2.3',
  name       : '🎌 AniTube.news',
  description: 'Animes dublados e legendados do AniTube.news. Funciona nos catálogos do Stremio, Cinemeta e Kitsu.',
  logo       : '',
  background : '',

  resources  : ['catalog', 'meta', 'stream'],
  types      : ['series', 'anime'],

  idPrefixes : ['anitube:', 'tt', 'kitsu', 'kitsu:', 'mal', 'mal:', 'anilist', 'anilist:', 'anidb', 'anidb:'],

  behaviorHints: { configurable: false, adult: false },

  catalogs: [
    {
      id   : 'anitube_ultimos',
      type : 'anime',
      name : '🆕 AniTube – Últimos Episódios',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      id   : 'anitube_recentes',
      type : 'anime',
      name : '📅 AniTube – Animes Recentes',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id   : 'anitube_mais_vistos',
      type : 'anime',
      name : '🔥 AniTube – Mais Vistos',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      id   : 'anitube_dublados',
      type : 'anime',
      name : '🎙️ AniTube – Dublados',
      extra: [{ name: 'skip', isRequired: false }],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ── Catalog Handler ───────────────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ id, extra = {} }) => {
  const skip   = parseInt(extra.skip, 10) || 0;
  const page   = Math.floor(skip / 20) + 1;
  const search = (extra.search || '').trim();

  const key    = `cat:${id}:${search}:${page}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let metas = [];

    if (search) {
      metas = await scraper.searchAnimes(search);
    } else {
      switch (id) {
        case 'anitube_ultimos':     metas = await scraper.getLatestEpisodes(page); break;
        case 'anitube_mais_vistos': metas = await scraper.getMostWatched(page);    break;
        case 'anitube_recentes':    metas = await scraper.getRecentAnimes(page);   break;
        case 'anitube_dublados':    metas = await scraper.getAnimeListDubbed(page); break;
        case 'anitube_lista':
        default:                    metas = await scraper.getAnimeList(page);      break;
      }
    }

    if (!Array.isArray(metas)) metas = [];
    const result = { metas, cacheMaxAge: 300 };
    cacheSet(key, result);
    return result;

  } catch (e) {
    console.error(`[Catalog] "${id}":`, e.message);
    return { metas: [] };
  }
});

// ── Meta Handler ──────────────────────────────────────────────────────────────
builder.defineMetaHandler(async ({ id }) => {
  if (!id.startsWith('anitube:')) return { meta: {} };

  const key    = `meta:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const animeId = id.replace('anitube:', '');
    const result  = await scraper.getAnimeMeta(animeId);
    if (!result?.meta) return { meta: {} };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.error(`[Meta] "${id}":`, e.message);
    return { meta: {} };
  }
});

// ── Stream Handler ────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ id, type }) => {
  const key    = `stream:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let streams = [];

    if (id.startsWith('anitube:')) {
      streams = await extractAniTubeById(id.replace('anitube:', ''));

    } else if (id.startsWith('tt')) {
      const parts   = id.split(':');
      const imdbId  = parts[0];
      const season  = parts[1] ? parseInt(parts[1], 10) : null;
      const episode = parts[2] ? parseInt(parts[2], 10) : null;

      if (type === 'movie') return { streams: [] };

      const meta = await resolveImdbTitle(imdbId);
      if (meta.title && isLikelyAnimeMeta(meta)) {
        const enriched = await enrichWithKitsuAliases(meta, imdbId);
        streams = await searchBothVersions(enriched.title, enriched.aliases, season, episode);
      }

    } else if (
      id.startsWith('kitsu:') ||
      id.startsWith('mal:') ||
      id.startsWith('anilist:') ||
      id.startsWith('anidb:')
    ) {
      const parts = id.split(':');
      const provider = parts[0];
      const seriesId = parts[1];
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
      if (title) {
        streams = await searchBothVersions(title, aliases, season, episode);
      }
    }

    if (!streams.length) return { streams: [] };
    const result = { streams, cacheMaxAge: 300 };
    cacheSet(key, result);
    return result;

  } catch (e) {
    console.error(`[Stream] "${id}":`, e.message);
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
    const r = await fetch(
      `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`,
      { timeout: 8000 }
    );
    if (!r.ok) return { title: null, aliases: [] };
    const j = await r.json();
    const meta = j?.meta || {};
    return {
      title      : meta.name || null,
      aliases    : meta.aliases || [],
      genres     : normalizeToArray(meta.genres || meta.genre || []),
      countries  : normalizeToArray(meta.countries || meta.country || []),
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
    const j = await fetchJson(
      `${KITSU_BASE_URL}/catalog/series/kitsu-anime-list/search=${encodeURIComponent(meta.title)}.json`
    );
    const match = (j?.metas || []).find(item => item?.imdb_id === imdbId)
      || (j?.metas || []).find(item => normalize(item?.name || '') === normalize(meta.title));

    if (!match) return { title: meta.title, aliases };

    const enrichedAliases = Array.isArray(match.aliases)
      ? match.aliases.filter(a => typeof a === 'string')
      : [];

    return {
      title: match.name || meta.title,
      aliases: enrichedAliases.length ? enrichedAliases : aliases,
    };
  } catch (_) {
    return { title: meta.title, aliases };
  }
}

async function resolveKitsuTitle(externalId) {
  // Tenta primeiro o proxy local
  try {
    const j = await fetchJson(`${KITSU_BASE_URL}/meta/anime/${externalId}.json`);
    const title = j?.meta?.name || null;
    if (title) {
      return { title, aliases: Array.isArray(j?.meta?.aliases) ? j.meta.aliases : [] };
    }
  } catch (_) {}

  // Fallback: API oficial do Kitsu (apenas para kitsu:ID)
  if (externalId.startsWith('kitsu:')) {
    const kitsuId = externalId.replace('kitsu:', '');
    try {
      const r = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`, {
        timeout: 8000,
        headers: { Accept: 'application/vnd.api+json' },
      });
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

  console.warn(`[Kitsu] Failed to resolve ${externalId}`);
  return { title: null, aliases: [] };
}

// ── Busca com verificação de relevância ───────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.45;
const EPISODE_FALLBACK_THRESHOLD = 0.35;

async function searchAndExtract(title, aliases, season, episode) {
  const match = await findBestMatch(buildQueries(title, aliases), buildAllTitles(title, aliases), SIMILARITY_THRESHOLD);
  if (!match) {
    console.warn(`[AniTube] Sem match confiável para "${title}"`);
    return episode ? searchEpisodeDirect(title, aliases, season, episode) : [];
  }
  console.log(`[AniTube] Match: "${match.name}" (score: ${match.score.toFixed(2)})`);
  const epId   = await resolveEpisodeId(match.id.replace('anitube:', ''), season, episode);
  if (!epId) return episode ? searchEpisodeDirect(title, aliases, season, episode) : [];
  const streams = await extractAniTubeById(epId);
  if (streams.length || !episode) return streams;
  return searchEpisodeDirect(title, aliases, season, episode);
}

// Busca dub e leg em paralelo, rotula os streams e retorna ambos
async function searchBothVersions(title, aliases, season, episode) {
  const queries    = buildQueries(title, aliases);
  const allTitles  = buildAllTitles(title, aliases);

  // Coleta todos os candidatos de todas as queries
  const seen = new Set();
  const candidates = [];
  for (const q of queries) {
    let results;
    try { results = await scraper.searchAnimes(q); } catch (_) { continue; }
    for (const c of (results || [])) {
      if (!seen.has(c.id)) { seen.add(c.id); candidates.push(c); }
    }
  }

  // Separa dub e leg pelo melhor score de cada grupo
  let dubMatch = null, dubScore = 0;
  let legMatch = null, legScore = 0;

  for (const c of candidates) {
    const isDub = /\b(dub(lado)?|dublado)\b/i.test(c.name || '');
    const isLeg = /\b(leg(endado)?|legendado)\b/i.test(c.name || '');
    const nameForScore = (c.name || '').replace(/\s*[\(\[]?\s*(dublado|legendado|dub|leg)\s*[\)\]]?/gi, '').trim();
    const score = allTitles.reduce((max, t) => Math.max(max, similarity(t, nameForScore)), 0);

    if (isDub && score > dubScore) { dubScore = score; dubMatch = c; }
    // Candidato sem marcação explícita conta como legendado
    if ((isLeg || (!isDub && !isLeg)) && score > legScore) { legScore = score; legMatch = c; }
  }

  const results = [];

  async function extractLabeled(match, score, label) {
    if (!match || score < SIMILARITY_THRESHOLD) return;
    const epId   = await resolveEpisodeId(match.id.replace('anitube:', ''), season, episode);
    if (!epId) return;
    const streams = await extractAniTubeById(epId);
    for (const s of streams) {
      results.push({ ...s, name: `${s.name} [${label}]` });
    }
  }

  await Promise.all([
    extractLabeled(dubMatch, dubScore, 'Dublado'),
    extractLabeled(legMatch, legScore, 'Legendado'),
  ]);

  // Fallback: se não encontrou nada, tenta searchAndExtract normal
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
    if (bestScore >= threshold) break;
  }

  if (!bestMatch || bestScore < threshold) return null;
  return { ...bestMatch, score: bestScore };
}

async function searchEpisodeDirect(title, aliases, season, episode) {
  const queries   = buildEpisodeQueries(title, aliases, episode);
  const allTitles = buildAllTitles(title, aliases);

  let bestMatch = null;
  let bestScore = 0;
  let bestIsDub = false;
  let matchedQuery = '';

  for (const q of queries) {
    let results;
    try {
      results = await scraper.searchAnimes(q);
    } catch (_) {
      continue;
    }
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
        bestScore    = score;
        bestMatch    = candidate;
        bestIsDub    = isDub;
        matchedQuery = q;
      }
    }

    if (bestScore >= EPISODE_FALLBACK_THRESHOLD) break;
  }

  if (!bestMatch || bestScore < EPISODE_FALLBACK_THRESHOLD) {
    console.warn(`[AniTube] Sem match de episódio para "${title}" ep ${episode} (melhor score: ${bestScore.toFixed(2)})`);
    return [];
  }

  console.log(`[AniTube] Match direto de episódio: "${matchedQuery}" → "${bestMatch.name}" (score: ${bestScore.toFixed(2)})`);

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
    const meta   = await scraper.getAnimeMeta(animeId);
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
  const seen    = new Set();
  const jpFirst = [];
  const enLast  = [];

  function addTo(arr, s) {
    if (!s || s.length < 2) return;
    const clean = s.trim();
    if (!seen.has(clean)) { seen.add(clean); arr.push(clean); }
  }

  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (typeof a !== 'string') continue;
      addTo(jpFirst, a.split(':')[0].split(' - ')[0].trim());
      addTo(jpFirst, a.trim());
    }
  }

  addTo(enLast, title.replace(/\s*\(Dub\)/i, '').split(':')[0].split(' - ')[0].trim());
  addTo(enLast, title.replace(/\s*\(Dub\)/i, '').trim());
  addTo(enLast, title);

  return [...jpFirst, ...enLast];
}

function buildEpisodeQueries(title, aliases, episode) {
  const seen = new Set();
  const queries = [];

  function add(query) {
    const clean = (query || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    queries.push(clean);
  }

  for (const base of buildQueries(title, aliases)) {
    add(`${base} ${episode}`);
    add(`${base} episódio ${episode}`);
    add(`${base} ep ${episode}`);
    add(base);
  }

  return queries;
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
      if (typeof a === 'string') {
        add(a);
        add(a.split(':')[0].trim());
      }
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
    return !/\bseason\s*[2-9]\b|\btemporada\s*[2-9]\b|\bpart\s*[2-9]\b/.test(text);
  }

  return text.includes(` ${season}`)
    || text.includes(`season ${season}`)
    || text.includes(`temporada ${season}`)
    || text.includes(`part ${season}`);
}

function isLikelyAnimeMeta(meta) {
  const genres = Array.isArray(meta?.genres) ? meta.genres.map(normalize) : [];
  const countries = Array.isArray(meta?.countries) ? meta.countries.map(normalize) : [];
  const description = normalize(meta?.description || '');

  if (genres.some(g => g.includes('anime'))) return true;
  if (genres.some(g => g.includes('animation') || g.includes('animacao'))) return true;
  if (countries.some(c => c.includes('japan') || c.includes('japao'))) return true;
  if (description.includes('anime') || description.includes('japanese animation')) return true;

  return false;
}

function normalizeToArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
  return [];
}

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[:\-–—]/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\b(the|a|an|no|wo|wa|ga|de|ni|to)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;

  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  }

  const setA = new Set(na.split(' ').filter(Boolean));
  const setB = new Set(nb.split(' ').filter(Boolean));
  let wordInter = 0;
  for (const w of setA) if (setB.has(w)) wordInter++;
  const jaccard = wordInter / (setA.size + setB.size - wordInter);

  const bgA = new Set(bigrams(na));
  const bgB = new Set(bigrams(nb));
  let bgInter = 0;
  for (const bg of bgA) if (bgB.has(bg)) bgInter++;
  const dice = (bgA.size + bgB.size) > 0 ? (2 * bgInter) / (bgA.size + bgB.size) : 0;

  return Math.max(jaccard, dice);
}

function bigrams(s) {
  const words = s.split(' ').filter(Boolean);
  if (words.length === 1) return words;
  const out = [];
  for (let i = 0; i < words.length - 1; i++) {
    out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

module.exports = builder.getInterface();
