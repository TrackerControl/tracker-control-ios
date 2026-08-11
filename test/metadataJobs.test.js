'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const refresh = require('../scripts/refresh-app-store-metadata');
const prune = require('../scripts/prune-app-store-cache');
const cron = require('../scripts/metadata-cron');

const silentLogger = { log() {}, warn() {}, error() {} };

function refreshClient(rows) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      if (/SELECT\s+apps\.appid/.test(text)) return { rows };
      if (/refresh_attempted_at = NOW\(\)/.test(text)) return { rowCount: 1, rows: [] };
      if (/refresh_failures = refresh_failures/.test(text)) return { rowCount: 1, rows: [] };
      if (/INSERT INTO app_store_cache/.test(text)) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected refresh query: ${text}`);
    }
  };
}

test('refresh selection prioritizes queued apps and applies capped exponential backoff', () => {
  const query = refresh.buildRefreshSelectionQuery({ limit: 100, minAgeDays: 30 });

  assert.deepEqual(query.values, [100, 30]);
  assert.match(query.text, /\(apps\.status = 'queued'\) DESC/);
  assert.match(query.text, /POWER\(2, GREATEST/);
  assert.match(query.text, /LEAST\(/);
  assert.match(query.text, /LIMIT \$1/);
});

test('refresh stops on a 429 and leaves remaining selections untouched', async () => {
  const client = refreshClient([
    { appid: 'com.example.first', status: 'analysed' },
    { appid: 'com.example.second', status: 'analysed' },
    { appid: 'com.example.third', status: 'analysed' }
  ]);
  const requested = [];
  const result = await refresh.refreshAppStoreMetadata(client, {
    delayMs: 0,
    storeClient: {
      async app({ appId }) {
        requested.push(appId);
        if (appId.endsWith('second')) throw new Error('App Store request failed (429)');
        return { appId, title: appId, version: '1.0' };
      }
    },
    logger: silentLogger
  });

  assert.deepEqual(requested, ['com.example.first', 'com.example.second']);
  assert.equal(result.attempted, 2);
  assert.equal(result.refreshed, 1);
  assert.equal(result.failed, 1);
  assert.match(result.stoppedReason, /429/);
  assert.equal(
    client.queries.filter(({ text }) => /refresh_failures = refresh_failures/.test(text)).length,
    1
  );
});

test('refresh stops after five consecutive failures', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    appid: `com.example.${index}`,
    status: 'analysed'
  }));
  const client = refreshClient(rows);
  let requests = 0;
  const result = await refresh.refreshAppStoreMetadata(client, {
    delayMs: 0,
    storeClient: {
      async app() {
        requests++;
        throw new Error('network unavailable');
      }
    },
    logger: silentLogger
  });

  assert.equal(requests, 5);
  assert.equal(result.attempted, 5);
  assert.equal(result.failed, 5);
  assert.equal(result.stoppedReason, '5 consecutive refresh failures');
});

test('prune builders protect referenced rows and trim oldest unreferenced rows', () => {
  const retention = prune.buildRetentionPruneQuery();
  const lru = prune.buildLruPruneQuery(50000);

  assert.match(retention.text, /NOT EXISTS/);
  assert.match(retention.text, /fetched_at < NOW\(\)/);
  assert.match(lru.text, /ORDER BY candidates\.fetched_at ASC/);
  assert.match(lru.text, /OFFSET \$1/);
  assert.deepEqual(lru.values, [50000]);
});

test('metadata cron closes both PostgreSQL clients after refresh and prune', async () => {
  const events = [];
  class FakeClient {
    constructor(options) {
      events.push(['construct', options]);
    }

    async connect() {
      events.push(['connect']);
    }

    async query(text) {
      if (/SELECT\s+apps\.appid/.test(text)) return { rows: [] };
      if (/SELECT COUNT\(\*\)::integer/.test(text)) return { rows: [{ count: '0' }] };
      if (/DELETE FROM app_store_cache/.test(text)) return { rowCount: 0, rows: [] };
      if (/pg_advisory_lock|pg_advisory_unlock/.test(text)) return { rows: [] };
      throw new Error(`Unexpected cron query: ${text}`);
    }

    async end() {
      events.push(['end']);
    }
  }

  const result = await cron.main({
    databaseUrl: 'postgres://example/test',
    ClientClass: FakeClient,
    refreshOptions: { limit: 1, delayMs: 0, logger: silentLogger },
    pruneOptions: { retentionDays: 90, maxUnreferenced: 10, logger: silentLogger }
  });

  assert.equal(result.refresh.attempted, 0);
  assert.equal(result.prune.unreferenced, 0);
  assert.equal(events.filter(([event]) => event === 'end').length, 2);
});
