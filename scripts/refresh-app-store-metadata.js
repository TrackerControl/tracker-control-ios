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
  absentRecheckDays: 90,
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
    absentRecheckDays: positiveInteger(env.METADATA_ABSENT_RECHECK_DAYS, DEFAULTS.absentRecheckDays),
    country: env.APP_STORE_COUNTRY || DEFAULTS.country,
    dryRun: false
  };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--limit=')) options.limit = positiveInteger(arg.slice(8), options.limit);
    else if (arg.startsWith('--min-age-days=')) options.minAgeDays = positiveInteger(arg.slice(15), options.minAgeDays);
    else if (arg.startsWith('--delay-ms=')) options.delayMs = nonNegativeInteger(arg.slice(11), options.delayMs);
    else if (arg.startsWith('--absent-recheck-days=')) options.absentRecheckDays = positiveInteger(arg.slice(22), options.absentRecheckDays);
    else if (arg.startsWith('--country=')) options.country = arg.slice(10) || options.country;
    else if (arg === '--help') {
      console.log([
        'Usage: pnpm refresh-metadata [options]',
        '',
        '  --limit=100          Maximum apps per run',
        '  --min-age-days=30   Minimum age of a successful refresh',
        '  --delay-ms=5000     Delay between Apple requests',
        '  --absent-recheck-days=90  Delay before rechecking an app absent from the storefront',
        '  --dry-run            Select and print apps without requesting Apple data'
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

// An app absent from the storefront is not failing: it is rechecked on its
// own slower cadence, in case it returns, rather than through the failure
// backoff.
function buildRefreshSelectionQuery({ limit, minAgeDays, absentRecheckDays = DEFAULTS.absentRecheckDays }) {
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
        cache.fetched_at IS NULL
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
        AND (
          cache.storefront_absent_since IS NULL
          OR cache.refresh_attempted_at IS NULL
          OR cache.refresh_attempted_at <= NOW() - ($3::integer * INTERVAL '1 day')
        )
      ORDER BY
        (apps.status = 'queued') DESC,
        GREATEST(
          COALESCE(cache.fetched_at, apps.added),
          COALESCE(cache.refresh_attempted_at, apps.added)
        ) ASC,
        apps.added ASC
      LIMIT $1
    `,
    values: [limit, minAgeDays, absentRecheckDays]
  };
}

function appStoreStatus(error) {
  if (error && Number.isInteger(error.statusCode)) return error.statusCode;
  const match = String(error && error.message || error).match(/(?:App Store request failed|App not found) \((\d+)\)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

// Absence is inferred by lib/appStore.js from an empty 200 response, not
// reported by Apple as a 404. The message check keeps errors raised elsewhere
// (and older stored shapes) classified the same way.
function isAppAbsent(error) {
  if (error && error.absent === true) return true;
  return /App not found \(404\)/.test(String(error && error.message || error));
}

function isRateLimitStop(error) {
  return [403, 429].includes(appStoreStatus(error));
}

function errorMessage(error) {
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
  // app was inserted by an older deployment during rollout. COALESCE covers
  // apps with a NULL details snapshot so an attempt is still recorded and the
  // selection query's backoff can apply instead of re-selecting this app on
  // every run.
  if (result.rowCount === 0) {
    await client.query(`
      INSERT INTO app_store_cache (appid_key, details, fetched_at, refresh_attempted_at)
      SELECT lower(appid), COALESCE(details::jsonb, '{}'::jsonb), added, NOW()
      FROM apps
      WHERE lower(appid) = lower($1)
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

// Absence clears the failure state: the request worked, and the answer was
// that the storefront does not list the app. The first absent observation is
// kept so a later recheck does not move it forward.
async function recordAbsence(client, appId) {
  await client.query(`
    UPDATE app_store_cache
    SET storefront_absent_since = COALESCE(storefront_absent_since, NOW()),
        refresh_failures = 0,
        refresh_error = NULL
    WHERE appid_key = lower($1)
  `, [appId]);
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
    absentRecheckDays = DEFAULTS.absentRecheckDays,
    country = DEFAULTS.country,
    dryRun = false,
    storeClient = store,
    sleepFn = sleep,
    logger = console
  } = options;
  const selection = buildRefreshSelectionQuery({ limit, minAgeDays, absentRecheckDays });
  const selected = await client.query(selection.text, selection.values);

  if (dryRun) {
    for (const row of selected.rows) logger.log(`${row.appid} (${row.status})`);
    return { selected: selected.rows, attempted: 0, refreshed: 0, absent: 0, failed: 0, stoppedReason: null };
  }

  let refreshed = 0;
  let absent = 0;
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
      if (isAppAbsent(error)) {
        await recordAbsence(client, row.appid);
        absent++;
        consecutiveFailures = 0;
        logger.log(`Not in the ${country} storefront: ${row.appid}`);
        continue;
      }

      const message = errorMessage(error);

      // A 403 or 429 describes this client, not the app that happened to be
      // next in the queue, so the run stops without recording a failure that
      // would push an innocent app into exponential backoff.
      if (isRateLimitStop(error)) {
        failed++;
        const retryAfter = error && error.retryAfter;
        stoppedReason = `Apple request stop signal: ${message}`
          + (retryAfter ? ` (retry-after: ${retryAfter})` : '');
        logger.warn(`Refresh stopped at ${row.appid}: ${stoppedReason}`);
        break;
      }

      await recordFailure(client, row.appid, message);
      failed++;
      logger.warn(`Refresh failed for ${row.appid}: ${message}`);

      consecutiveFailures++;
      if (consecutiveFailures >= 5) {
        stoppedReason = '5 consecutive transport failures';
        break;
      }
    }
  }

  return {
    selected: selected.rows,
    attempted: refreshed + absent + failed,
    refreshed,
    absent,
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
      options.logger || console,
      { tryLock: true }
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
  isAppAbsent,
  isRateLimitStop,
  refreshAppStoreMetadata,
  main
};
