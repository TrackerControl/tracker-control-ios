const fs = require('fs');
const path = require('path');

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'cache');

// Ensure cache directory exists
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch (err) {
  console.error('Could not create cache directory:', CACHE_DIR, err.message);
}

function cachePath(key) {
  return path.join(CACHE_DIR, key + '.json');
}

/**
 * Read from cache. Returns { data, age } or null if no cache exists.
 * age is in milliseconds since the cache was written.
 */
function read(key) {
  const file = cachePath(key);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cached = JSON.parse(raw);
    const age = Date.now() - (cached._cachedAt || 0);
    return { data: cached.data, age };
  } catch (err) {
    return null;
  }
}

/**
 * Write to cache.
 */
function write(key, data) {
  const file = cachePath(key);
  try {
    const payload = JSON.stringify({ data, _cachedAt: Date.now() });
    fs.writeFileSync(file, payload, 'utf-8');
  } catch (err) {
    console.error('Cache write error:', err.message);
  }
}

/**
 * Get cached data if fresh enough, otherwise return stale data with a flag.
 * @param {string} key
 * @param {number} maxAge - max age in ms before considered stale
 * @returns {{ data, fresh: boolean } | null}
 */
function get(key, maxAge) {
  const cached = read(key);
  if (!cached) return null;
  return {
    data: cached.data,
    fresh: cached.age < maxAge
  };
}

module.exports = { read, write, get };
