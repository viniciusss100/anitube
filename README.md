# 🎌 Stremio Addon — AniTube.news  v4.3.0

Addon para o [Stremio](https://www.stremio.com/) que integra o conteúdo de [AniTube.news](https://www.anitube.news/), um dos maiores portais de animes em português do Brasil.

> Revisão completa v4.3 — cache unificado, scraper resiliente, proxy HLS seguro, rate-limit e melhor matching de títulos.

---

## ✨ Funcionalidades

| Recurso | Descrição |
|---|---|
| 🆕 **Últimos Episódios** | Home `div.epiItem` com deduplicação série/episódio |
| 🔥 **Mais Vistos** | Container `mais vistos` com fallback |
| 📺 **Animes Recentes** | Container `recentes` + fallback segundo container |
| 🎙️ **Dublados** | `?genero=dublado` paginado |
| 🔍 **Busca** | Pesquisa por nome dentro do Stremio (com paginação local) |
| 📄 **Meta completo** | Título, poster, sinopse, gêneros, ano, vídeos ordenados |
| ▶️ **Streams HLS** | `videohls.php?d=` + Blogger/GoogleVideo via `batchexecute` |
| 💾 **Cache LRU** | `src/cache.js` unificado com TTL + LRU + coalescing |
| 🛡️ **Proxy seguro** | SSRF check, block private IPs, range support, m3u8 rewrite |
| 🔗 **Kitsu/Cinemeta** | Resolução de títulos via `kitsufortheweebs` + API Kitsu |

---

## 🔧 Como funciona a extração de vídeo

```
Página do Episódio ( /<id>b/ → div.pagEpiAbas )
 └── aba-target → div#<id> → iframe.metaframe[src]
     ├── anivideo.net/videohls.php?d=<url_m3u8>  → HLS direto (proxy /proxy/hls.m3u8)
     └── anitube.zip/xxx/bg.mp4  → fetch HTML → blogger.com/video.g?token=
                                  └── POST blogger.com/_/BloggerVideoPlayerUi/data/batchexecute
                                      └── GoogleVideo URLs (mp4, 480p+)
```

---

## 🚀 Instalação

### Pré-requisitos
- Node.js >= 18
- npm

```bash
cd stremio-anitube
npm install
cp .env.example .env
# edite .env se quiser TMDB_API_KEY ou PUBLIC_URL
npm start
# abre http://127.0.0.1:7000/manifest.json
```

### Instalar no Stremio
1. Abra o **Stremio**
2. Vá em **Addons → + Add Addon**
3. Cole: `http://127.0.0.1:7000/manifest.json` (ou seu `PUBLIC_URL/manifest.json`)
4. Clique em **Install** ✅

---

## ⚙️ Configuração (.env)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `7000` | Porta do servidor |
| `PUBLIC_URL` | *(auto)* | URL pública para gerar links de proxy (ex: `https://seu.dominio.com`) |
| `TMDB_API_KEY` |  | Chave TMDB para enriquecer posters |
| `ANITUBE_BASES` | `anitube.zip,anitube.news` | Bases para fallback |
| `KITSU_BASE_URL` | `kitsufortheweebs…` | Proxy Kitsu/Cinemeta |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `PROXY_ALLOWED_DOMAINS` | lista padrão | Domínios permitidos no proxy |
| `CACHE_TTL_MS` | `120000` | TTL cache streams/catalog |

Instalar com config via URL:
```
https://seu.dominio.com/tmdb=SUA_CHAVE/manifest.json
```

---

## 📡 Endpoints

| Endpoint | Descrição |
|---|---|
| `GET /health` | Healthcheck + stats cache |
| `GET /manifest.json` | Manifesto Stremio |
| `GET /catalog/series/anitube_ultimos.json` | Últimos episódios |
| `GET /catalog/series/anitube_mais_vistos.json` | Mais vistos |
| `GET /catalog/series/anitube_recentes.json` | Recentes |
| `GET /catalog/series/anitube_dublados.json` | Dublados |
| `GET /catalog/series/anitube_*.json?search=naruto` | Busca |
| `GET /meta/series/anitube:{id}.json` | Meta + vídeos |
| `GET /stream/series/anitube:{id}.json` | Streams |
| `GET /stream/series/tt{id}:{s}:{e}.json` | Streams via IMDB |
| `GET /proxy/hls.m3u8?url=&referer=` | Proxy M3U8 com rewrite |
| `GET /proxy/segment?url=&referer=` | Proxy segmentos/mp4 com Range |

---

## 🗂️ Estrutura

```
stremio-anitube/
├── addon.js            ← Manifest + handlers (catalog/meta/stream) + matching
├── server.js           ← Express + helmet/cors/rate-limit + proxy HLS/segment
├── src/
│   ├── config.js       ← Config centralizada via .env
│   ├── logger.js       ← Logger com níveis
│   ├── cache.js        ← LRU + TTL + coalescing unificado
│   ├── scraper.js      ← Scraping AniTube (retry+jitter, pool, fallback)
│   ├── extractor.js    ← Extração HLS/Blogger/GoogleVideo (agents keepAlive)
│   └── public/index.html ← UI configure com preview + validação
└── README.md
```

---

## 🛠️ Melhorias v4.3

- **src/config.js + logger.js** — centraliza env e logs.
- **src/cache.js** — LRU real, limpeza periódica, `getOrSet` com deduplicação de promises.
- **scraper.js** — retry exponencial + jitter, fallback multi-domínio, concorrência limitada (5), cache negativo TMDB, `cleanTitle` e `extractEpisodeNumber` mais estritos.
- **extractor.js** — keepAlive agents, `extractHLSFromVideoHLS` com base64/double-decode, Blogger parser tolerante, `extractStreams` paralelizado + dedup.
- **addon.js** — `fetchJson` com AbortController+retry, manifest corrigido (`type: series`), `behaviorHints.configurationRequired=false`, handlers com validação, similaridade com normalização NFD + jaccard+dice ponderado, `isSeasonCompatible` cobrindo `cour`.
- **server.js** — helmet/cors/compression/morgan/rate-limit opcionais (graceful fallback), SSRF com block private IPs, `/health`, reescrita de m3u8 com `PUBLIC_URL` dinâmico, streaming com magic-byte sniffing, shutdown gracioso.
- **frontend** — preview do manifest link, validação TMDB key, fallback clipboard.
- **package.json** — deps de segurança e scripts lint/health.

---

## ⚠️ Aviso Legal

Projeto **não oficial**, uso pessoal. Scraping do AniTube.news. Conteúdo pertence aos respectivos titulares.

## 📝 Licença

MIT
