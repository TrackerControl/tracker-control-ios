'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  APP_STORE_CACHE_RETENTION_DAYS,
  buildAppStoreCachePrune,
  buildAppStoreCacheUpsert,
} = require('../models/Apps');

test('App Store cache upsert normalizes keys and retains full metadata', () => {
  const details = {
    appId: 'com.example.Cached',
    title: 'Cached App',
    icon: 'https://example.test/icon.png',
    free: true,
  };

  const query = buildAppStoreCacheUpsert([details]);

  assert.match(query.text, /ON CONFLICT \(appid_key\) DO UPDATE/);
  assert.deepEqual(query.values, ['com.example.cached', details]);
});

test('App Store cache upsert skips malformed bundle IDs', () => {
  const query = buildAppStoreCacheUpsert([
    { appId: 'invalid/id', title: 'Invalid' },
    null,
  ]);

  assert.equal(query, null);
});

test('App Store cache upsert deduplicates case-insensitive bundle IDs', () => {
  const first = { appId: 'com.example.Cached', title: 'First' };
  const second = { appId: 'COM.EXAMPLE.CACHED', title: 'Last' };
  const query = buildAppStoreCacheUpsert([first, second]);

  assert.deepEqual(query.values, ['com.example.cached', second]);
  assert.equal((query.text.match(/\$1/g) || []).length, 1);
});

test('App Store cache pruning uses the configured retention window', () => {
  const query = buildAppStoreCachePrune();

  assert.match(query.text, /fetched_at < NOW\(\) - \(\$1::integer \* INTERVAL '1 day'\)/);
  assert.deepEqual(query.values, [APP_STORE_CACHE_RETENTION_DAYS]);
});
