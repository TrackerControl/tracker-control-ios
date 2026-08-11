#!/usr/bin/env node

'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const store = require('../lib/appStore');
const { buildAppStoreCacheUpsert } = require('../models/Apps');
const { withAdvisoryLock } = require('../lib/jobLock');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

const REFRESH_LOCK_KEYS = [1414677323, 1380992849]; // "TRCK", "REFR"
const DEFAULTS = Object.freeze({
  limit: 100,
  minAgeDays: 30,
  delayMs: 5000,
  country: 'gb'
});

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    limit: positiveInteger(env.METADATA_REFRESH_LIMIT, DEFAULTS.limit),
    minAgeDays: positiveInteger(env.METADATA_REFRESH_MIN_AGE_DAYS, DEFAULTS.minAgeDays),
    delayMs: nonNegativeInteger(env.METADATA_REFRESH_DELAY_MS, DEFAULTS.delayMs),
    country: env.APP_STORE_COUNTRY || DEFAULTS.country,
    dryRun: false
  };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--limit=')) options.limit = positiveInteger(arg.slice(8), options.limit);
    else if (arg.startsWith('--min-age-days=')) options.minAgeDays = positiveInteger(arg.slice(15), options.minAgeDays);
    else if (arg.startsWith('--delay-ms=')) options.delayMs = nonNegativeInteger(arg.slice(11), options.delayMs);
    else if (arg.startsWith('--country=')) options.country = arg.slice(9) || options.country;
    else if (arg === '--help') {
      console.log([
        'Usage: pnpm refresh-metadata [options]',
        '',
        '  --limit=100          Maximum apps per run',
        '  --min-age-days=30   Minimum age of a successful refresh',
        '  --delay-ms=5000     Delay between Apple requests',
        '  --dry-run            Select and print apps without requesting Apple data'
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function buildRefreshSelectionQuery({ limit, minAgeDays }) {
  return {
    text: `
      SELECT
        apps.appid,
        apps.status,
        cache.fetched_at,
        cache.refresh_failures,
        cache.refresh_attempted_at
      FROM apps
      LEFT JOIN app_store_cache cache
        ON cache.appid_key = lower(apps.appid)
      WHERE (
        apps.status = 'queued'
        OR cache.fetched_at IS NULL
        OR cache.fetched_at <= NOW() - ($2::integer * INTERVAL '1 day')
      )
        AND (
          COALESCE(cache.refresh_failures, 0) = 0
          OR cache.refresh_attempted_at IS NULL
          OR cache.refresh_attempted_at <= NOW() - (
            LEAST(
              POWER(2, GREATEST(COALESCE(cache.refresh_failures, 1) - 1, 0)),
              30
            )::integer * INTERVAL '1 day'
          )
        )
      ORDER BY
        (apps.status = 'queued') DESC,
        cache.fetched_at ASC NULLS FIRST,
        apps.added ASC
      LIMIT $1
    `,
    values: [limit, minAgeDays]
  };
}

function appStoreStatus(error) {
  if (error && Number.isInteger(error.statusCode)) return error.statusCode;
  const match = String(error && error.message || error).match(/(?:App Store request failed|App not found) \((\d+)\)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isRateLimitStop(error) {
  return [403, 429].includes(appStoreStatus(error));
}

function errorMessage(error) {
  const status = appStoreStatus(error);
  if (status === 404) return 'app_not_found';
  return String(error && error.message || error).slice(0, 2000);
}

async function markAttempt(client, appId) {
  const result = await client.query(
    `UPDATE app_store_cache
     SET refresh_attempted_at = NOW()
     WHERE appid_key = lower($1)`,
    [appId]
  );

  // Migration 013 backfills this row, but keep the refresher safe if a new
  // app was inserted by an older deployment during rollout.
  if (result.rowCount === 0) {
    await client.query(`
      INSERT INTO app_store_cache (appid_key, details, fetched_at, refresh_attempted_at)
      SELECT lower(appid), details::jsonb, added, NOW()
      FROM apps
      WHERE lower(appid) = lower($1)
        AND details IS NOT NULL
      ON CONFLICT (appid_key) DO UPDATE
      SET refresh_attempted_at = NOW()
    `, [appId]);
  }
}

async function recordFailure(client, appId, message) {
  await client.query(`
    UPDATE app_store_cache
    SET refresh_failures = refresh_failures + 1,
        refresh_error = $2
    WHERE appid_key = lower($1)
  `, [appId, message]);
}

async function recordSuccess(client, details, fetchedAt) {
  const query = buildAppStoreCacheUpsert([details], fetchedAt);
  if (query) await client.query(query.text, query.values);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function refreshAppStoreMetadata(client, options = {}) {
  const {
    limit = DEFAULTS.limit,
    minAgeDays = DEFAULTS.minAgeDays,
    delayMs = DEFAULTS.delayMs,
    country = DEFAULTS.country,
    dryRun = false,
    storeClient = store,
    sleepFn = sleep,
    logger = console
  } = options;
  const selection = buildRefreshSelectionQuery({ limit, minAgeDays });
  const selected = await client.query(selection.text, selection.values);

  if (dryRun) {
    for (const row of selected.rows) logger.log(`${row.appid} (${row.status})`);
    return { selected: selected.rows, attempted: 0, refreshed: 0, failed: 0, stoppedReason: null };
  }

  let refreshed = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stoppedReason = null;

  for (const [index, row] of selected.rows.entries()) {
    if (index > 0 && delayMs > 0) await sleepFn(delayMs);
    await markAttempt(client, row.appid);

    try {
      const details = await storeClient.app({ appId: row.appid, country });
      await recordSuccess(client, details, new Date());
      refreshed++;
      consecutiveFailures = 0;
      logger.log(`Refreshed ${row.appid}`);
    } catch (error) {
      const message = errorMessage(error);
      await recordFailure(client, row.appid, message);
      failed++;
      consecutiveFailures++;
      logger.warn(`Refresh failed for ${row.appid}: ${message}`);

      if (isRateLimitStop(error)) {
        stoppedReason = `Apple request stop signal: ${message}`;
        break;
      }
      if (consecutiveFailures >= 5) {
        stoppedReason = '5 consecutive refresh failures';
        break;
      }
    }
  }

  return {
    selected: selected.rows,
    attempted: refreshed + failed,
    refreshed,
    failed,
    stoppedReason
  };
}

async function main({
  databaseUrl = process.env.DATABASE_URL,
  ClientClass = Client,
  options = parseArgs()
} = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. Configure .env or analyser/.env.');

  const client = new ClientClass({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await withAdvisoryLock(
      client,
      REFRESH_LOCK_KEYS,
      () => refreshAppStoreMetadata(client, options),
      options.logger || console
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  REFRESH_LOCK_KEYS,
  DEFAULTS,
  parseArgs,
  buildRefreshSelectionQuery,
  appStoreStatus,
  isRateLimitStop,
  refreshAppStoreMetadata,
  main
};
