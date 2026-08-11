'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAnalysisProvenanceSourceSql,
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

test('App Store cache upsert accepts an explicit successful fetch time and clears retry state', () => {
  const details = { appId: 'com.example.Cached', version: '2.0' };
  const fetchedAt = new Date('2026-08-11T03:00:00Z');
  const query = buildAppStoreCacheUpsert([details], fetchedAt);

  assert.match(query.text, /fetched_at = EXCLUDED\.fetched_at/);
  assert.match(query.text, /refresh_failures = 0/);
  assert.match(query.text, /refresh_error = NULL/);
  assert.deepEqual(query.values, ['com.example.cached', details, fetchedAt]);
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

test('analysis provenance source selects artifact version and freshest storefront', () => {
  const source = buildAnalysisProvenanceSourceSql({ analysisExpression: '$2::jsonb' });

  assert.deepEqual(source.columns, [
    'app_version',
    'app_store_updated',
    'storefront_details',
    'storefront_fetched_at'
  ]);
  assert.match(source.select.appVersion, /\$2::jsonb/);
  assert.match(source.select.storefrontDetails, /storefront_cache\.details/);
  assert.match(source.select.storefrontDetails, /apps\.details::jsonb/);
  assert.match(source.join, /lower\(apps\.appid\)/);
});
