'use strict';

/**
 * Cache LRU unificado com TTL e política de expiração periódica.
 * Uso: get, set, getOrSet, delete, clear, stats.
 * Substitui tanto o Map interno de addon.js quanto a versão anterior de src/cache.js.
 */

const config = require('./config');

const MAX_KEYS = config.cache.maxKeys;
const DEFAULT_TTL = config.cache.ttlMs;

// Map preserva ordem de inserção -> usado para LRU
const store = new Map();

// Limpeza periódica de expirados (60s)
const CLEANUP_INTERVAL = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of store.entries()) {
    if (entry.expires <= now) store.delete(k);
  }
}, CLEANUP_INTERVAL).unref();

function isExpired(entry) {
  return entry.expires <= Date.now();
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (isExpired(entry)) { store.delete(key); return null; }
  // LRU: move para o fim
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

function set(key, value, ttl = DEFAULT_TTL) {
  if (store.size >= MAX_KEYS) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
  }
  store.set(key, { value, expires: Date.now() + ttl });
}

function del(key) {
  store.delete(key);
}

function clear() {
  store.clear();
}

function has(key) {
  const entry = store.get(key);
  if (!entry) return false;
  if (isExpired(entry)) { store.delete(key); return false; }
  return true;
}

/**
 * Padrão getOrSet: se estiver em cache retorna, senão executa fetcher, armazena e retorna.
 * Deduplica fetches concorrentes para a mesma chave (promise coalescing).
 */
const pending = new Map(); // key -> Promise

async function getOrSet(key, fetcher, ttl = DEFAULT_TTL) {
  const cached = get(key);
  if (cached !== null) return cached;

  if (pending.has(key)) return pending.get(key);

  const p = (async () => {
    try {
      const value = await fetcher();
      set(key, value, ttl);
      return value;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, p);
  return p;
}

function stats() {
  return { size: store.size, maxKeys: MAX_KEYS, pending: pending.size };
}

module.exports = { get, set, delete: del, clear, has, getOrSet, stats, _store: store };
