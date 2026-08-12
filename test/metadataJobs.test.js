'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const refresh = require('../scripts/refresh-app-store-metadata');
const prune = require('../scripts/prune-app-store-cache');
const cron = require('../scripts/metadata-cron');
const { withAdvisoryLock } = require('../lib/jobLock');

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
  assert.match(query.text, /cache\.fetched_at IS NULL/);
  assert.doesNotMatch(query.text, /WHERE \(\s*apps\.status = 'queued'/);
  assert.match(query.text, /GREATEST\(/);
  assert.match(query.text, /POWER\(2, GREATEST/);
  assert.match(query.text, /LEAST\(/);
  assert.match(query.text, /LIMIT \$1/);
});

test('refresh parses country flags without retaining the equals sign', () => {
  assert.equal(refresh.parseArgs(['--country=gb']).country, 'gb');
});

test('metadata cron forwards refresh, prune, and shared flags', () => {
  const options = cron.parseArgs([
    '--limit=7',
    '--min-age-days=14',
    '--delay-ms=0',
    '--country=gb',
    '--retention-days=60',
    '--max-unreferenced=12',
    '--dry-run'
  ]);

  assert.deepEqual(options.refreshOptions, {
    limit: 7,
    minAgeDays: 14,
    delayMs: 0,
    country: 'gb',
    dryRun: true
  });
  assert.deepEqual(options.pruneOptions, {
    retentionDays: 60,
    maxUnreferenced: 12,
    dryRun: true
  });
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
  // The 429 describes the client, so the app it interrupted keeps a clean
  // failure count instead of being pushed into exponential backoff.
  assert.equal(
    client.queries.filter(({ text }) => /refresh_failures = refresh_failures/.test(text)).length,
    0
  );
});

test('a rate limit stop reports Apple\'s Retry-After when it sends one', async () => {
  const client = refreshClient([{ appid: 'com.example.first', status: 'analysed' }]);
  const result = await refresh.refreshAppStoreMetadata(client, {
    delayMs: 0,
    storeClient: {
      async app() {
        throw Object.assign(new Error('App Store request failed (429)'), {
          statusCode: 429,
          retryAfter: '120'
        });
      }
    },
    logger: silentLogger
  });

  assert.match(result.stoppedReason, /retry-after: 120/);
});

test('a real HTTP 404 counts against the transport failure cap', async () => {
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
        throw Object.assign(new Error('App Store request failed (404)'), { statusCode: 404 });
      }
    },
    logger: silentLogger
  });

  // Apple signals a missing app with an empty 200, so a 404 from the transport
  // is a routing or edge problem rather than six apps leaving the store.
  assert.equal(requests, 5);
  assert.equal(result.stoppedReason, '5 consecutive transport failures');
});

test('absence is classified by flag as well as by legacy message shape', () => {
  assert.equal(refresh.isAppAbsent(Object.assign(new Error('empty result'), { absent: true })), true);
  assert.equal(refresh.isAppAbsent(new Error('App not found (404)')), true);
  assert.equal(
    refresh.isAppAbsent(Object.assign(new Error('App Store request failed (404)'), { statusCode: 404 })),
    false
  );
});

test('refresh stops after five consecutive transport failures', async () => {
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
  assert.equal(result.stoppedReason, '5 consecutive transport failures');
});

test('delisted apps do not consume the transport failure cap', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    appid: `com.example.delisted.${index}`,
    status: 'analysed'
  }));
  const client = refreshClient(rows);
  let requests = 0;
  const result = await refresh.refreshAppStoreMetadata(client, {
    delayMs: 0,
    storeClient: {
      async app() {
        requests++;
        throw new Error('App not found (404)');
      }
    },
    logger: silentLogger
  });

  assert.equal(requests, 6);
  assert.equal(result.stoppedReason, null);
  assert.equal(result.failed, 6);
});

test('prune builders protect referenced rows and trim oldest unreferenced rows', () => {
  const retention = prune.buildRetentionPruneQuery();
  const lru = prune.buildLruPruneQuery(50000);

  assert.match(retention.text, /NOT EXISTS/);
  assert.match(retention.text, /fetched_at < NOW\(\)/);
  assert.match(lru.text, /ORDER BY candidates\.fetched_at DESC/);
  assert.match(lru.text, /OFFSET \$1/);
  assert.deepEqual(lru.values, [50000]);
});

test('prune dry-run reports expiration and LRU deletion estimates', async () => {
  const queries = [];
  const client = {
    async query(text, params) {
      queries.push({ text, params });
      if (/fetched_at < NOW\(\)/.test(text)) return { rows: [{ count: '120' }] };
      if (/NOT EXISTS/.test(text)) return { rows: [{ count: '60000' }] };
      throw new Error(`Unexpected dry-run query: ${text}`);
    }
  };
  const result = await prune.pruneAppStoreCache(client, {
    retentionDays: 90,
    maxUnreferenced: 50000,
    dryRun: true,
    logger: silentLogger
  });

  assert.equal(result.retentionWouldDelete, 120);
  assert.equal(result.lruWouldDelete, 9880);
  assert.equal(queries.length, 2);
});

test('try-lock skips a mutating job instead of waiting', async () => {
  const client = {
    async query(text) {
      if (/pg_try_advisory_lock/.test(text)) {
        return { rows: [{ pg_try_advisory_lock: false }] };
      }
      throw new Error(`Unexpected lock query: ${text}`);
    }
  };
  let ran = false;
  const result = await withAdvisoryLock(
    client,
    [1, 2],
    async () => { ran = true; },
    silentLogger,
    { tryLock: true }
  );

  assert.deepEqual(result, { skipped: true });
  assert.equal(ran, false);
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
      if (/pg_try_advisory_lock/.test(text)) {
        return { rows: [{ pg_try_advisory_lock: true }] };
      }
      if (/pg_advisory_unlock/.test(text)) return { rows: [] };
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
