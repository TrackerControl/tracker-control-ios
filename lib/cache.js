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
 * Read from cache. Returns { data, meta } or null if no cache exists.
 */
function read(key) {
  const file = cachePath(key);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cached = JSON.parse(raw);
    return { data: cached.data, meta: cached._meta || {} };
  } catch (err) {
    return null;
  }
}

/**
 * Write to cache with optional metadata (e.g. appCount for change detection).
 */
function write(key, data, meta) {
  const file = cachePath(key);
  try {
    const payload = JSON.stringify({ data, _meta: meta || {} });
    fs.writeFileSync(file, payload, 'utf-8');
  } catch (err) {
    console.error('Cache write error:', err.message);
  }
}

function invalidate(key) {
  const file = cachePath(key);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    // ignore — file may not exist
  }
}

module.exports = { read, write, invalidate };
