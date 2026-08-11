'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Resolved at require time, so it must be set before lib/cache is loaded.
process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cache-schema-'));

const cache = require('../lib/cache');

const cacheFile = (key) => path.join(process.env.CACHE_DIR, key + '.json');

test('the cache is keyed by builder schema as well as data signature', async (t) => {
  t.after(() => fs.rmSync(process.env.CACHE_DIR, { recursive: true, force: true }));

  await t.test('a round-trip returns the data and its signature', () => {
    const signature = { appCount: 2, latestAnalysis: '2025-01-02T03:04:05.000Z' };
    cache.write('roundtrip', { totalApps: 2 }, signature);

    const cached = cache.read('roundtrip');
    assert.deepEqual(cached.data, { totalApps: 2 });
    assert.deepEqual(cached.meta, signature);
  });

  await t.test('an entry from an older schema reads as a miss', () => {
    // CACHE_DIR is a persistent volume, so entries written before a deploy
    // survive it. The signature alone still matches when only the derivation
    // changed, which is what the schema version exists to catch.
    const signature = { appCount: 2, latestAnalysis: '2025-01-02T03:04:05.000Z' };
    fs.writeFileSync(cacheFile('stale'), JSON.stringify({
      data: { totalApps: 2 },
      _meta: signature,
      _schema: cache.SCHEMA_VERSION - 1
    }), 'utf-8');

    assert.equal(cache.read('stale'), null);
  });

  await t.test('an entry predating the schema field reads as a miss', () => {
    fs.writeFileSync(cacheFile('legacy'), JSON.stringify({
      data: { totalApps: 2 },
      _meta: { appCount: 2, latestAnalysis: null }
    }), 'utf-8');

    assert.equal(cache.read('legacy'), null);
  });

  await t.test('a rewrite at the current schema is readable again', () => {
    cache.write('stale', { totalApps: 3 }, { appCount: 3, latestAnalysis: null });
    assert.deepEqual(cache.read('stale').data, { totalApps: 3 });
  });
});
