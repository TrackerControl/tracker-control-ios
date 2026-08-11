'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildAppStoreCacheUpsert } = require('../models/Apps');

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
