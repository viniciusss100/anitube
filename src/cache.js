// src/cache.js
const cache = new Map();
const MAX_KEYS = 500;

// Periodic cleanup of expired items
setInterval(() => {
    const now = Date.now();
    for (const [key, { expires }] of cache.entries()) {
        if (expires <= now) cache.delete(key);
    }
}, 60000).unref();

const getOrSet = async (key, fetcher, ttl = 3600000) => {
    const now = Date.now();
    if (cache.has(key)) {
        const entry = cache.get(key);
        if (entry.expires > now) {
            // LRU logic: move to end
            cache.delete(key);
            cache.set(key, entry);
            return entry.value;
        }
        cache.delete(key);
    }
    const value = await fetcher();
    
    // LRU enforce size limit
    if (cache.size >= MAX_KEYS) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }
    
    cache.set(key, { value, expires: now + ttl });
    return value;
};

const clear = () => cache.clear();

module.exports = { getOrSet, clear };
