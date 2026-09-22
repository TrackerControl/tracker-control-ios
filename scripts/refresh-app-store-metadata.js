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
  country: 'gb',
  rateLimitRetries: 3,
  rateLimitBackoffMs: 60000
});

// Apple's throttling clears in minutes, so a pause is worth taking inside the
// run; anything longer than this belongs to the next scheduled run instead of
// a cron service sitting idle with an open database connection.
const MAX_RATE_LIMIT_BACKOFF_MS = 900000;

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
    rateLimitRetries: nonNegativeInteger(
      env.METADATA_REFRESH_RATE_LIMIT_RETRIES,
      DEFAULTS.rateLimitRetries
    ),
    rateLimitBackoffMs: nonNegativeInteger(
      env.METADATA_REFRESH_RATE_LIMIT_BACKOFF_MS,
      DEFAULTS.rateLimitBackoffMs
    ),
    dryRun: false
  };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--limit=')) options.limit = positiveInteger(arg.slice(8), options.limit);
    else if (arg.startsWith('--min-age-days=')) options.minAgeDays = positiveInteger(arg.slice(15), options.minAgeDays);
    else if (arg.startsWith('--delay-ms=')) options.delayMs = nonNegativeInteger(arg.slice(11), options.delayMs);
    else if (arg.startsWith('--country=')) options.country = arg.slice(10) || options.country;
    else if (arg.startsWith('--rate-limit-retries=')) options.rateLimitRetries = nonNegativeInteger(arg.slice(21), options.rateLimitRetries);
    else if (arg.startsWith('--rate-limit-backoff-ms=')) options.rateLimitBackoffMs = nonNegativeInteger(arg.slice(24), options.rateLimitBackoffMs);
    else if (arg === '--help') {
      console.log([
        'Usage: pnpm refresh-metadata [options]',
        '',
        '  --limit=100          Maximum apps per run',
        '  --min-age-days=30   Minimum age of a successful refresh',
        '  --delay-ms=5000     Delay between Apple requests',
        '  --rate-limit-retries=3        Pauses allowed per run when Apple throttles',
        '  --rate-limit-backoff-ms=60000 First pause length; doubles per pause, capped at 15 minutes',
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
      ORDER BY
        (apps.status = 'queued') DESC,
        GREATEST(
          COALESCE(cache.fetched_at, apps.added),
          COALESCE(cache.refresh_attempted_at, apps.added)
        ) ASC,
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

// Absence is inferred by lib/appStore.js from an empty 200 response, not
// reported by Apple as a 404. The message check keeps errors raised elsewhere
// (and older stored shapes) classified the same way.
function isAppAbsent(error) {
  if (error && error.absent === true) return true;
  return /App not found \(404\)/.test(String(error && error.message || error));
}

function isRateLimited(error) {
  return [403, 429].includes(appStoreStatus(error));
}

// Retry-After is sent either as a number of seconds or as an HTTP date.
function retryAfterMs(error) {
  const retryAfter = error && error.retryAfter;
  if (retryAfter === null || retryAfter === undefined || retryAfter === '') return null;

  const seconds = Number.parseInt(String(retryAfter).trim(), 10);
  if (Number.isInteger(seconds) && String(seconds) === String(retryAfter).trim())
    return seconds > 0 ? seconds * 1000 : 0;

  const deadline = Date.parse(retryAfter);
  if (Number.isFinite(deadline)) return Math.max(deadline - Date.now(), 0);
  return null;
}

// Apple's own Retry-After wins when it sends one; otherwise the pause doubles
// per pause taken in this run. Either way the cap applies, so a header asking
// for an hour does not hold the run open for an hour.
function rateLimitPauseMs(error, pausesTaken, backoffMs) {
  const requested = retryAfterMs(error);
  const backoff = backoffMs * Math.pow(2, Math.max(pausesTaken - 1, 0));
  return Math.min(requested === null ? backoff : requested, MAX_RATE_LIMIT_BACKOFF_MS);
}

function errorMessage(error, absent = isAppAbsent(error)) {
  if (absent) return 'app_not_found';
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
    rateLimitRetries = DEFAULTS.rateLimitRetries,
    rateLimitBackoffMs = DEFAULTS.rateLimitBackoffMs,
    dryRun = false,
    storeClient = store,
    sleepFn = sleep,
    logger = console
  } = options;
  const selection = buildRefreshSelectionQuery({ limit, minAgeDays });
  const selected = await client.query(selection.text, selection.values);

  if (dryRun) {
    for (const row of selected.rows) logger.log(`${row.appid} (${row.status})`);
    return { selected: selected.rows, attempted: 0, refreshed: 0, failed: 0, pauses: 0, stoppedReason: null };
  }

  let refreshed = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stoppedReason = null;
  // Budgeted across the whole run rather than per app, so a throttled night
  // pauses a few times and gives up instead of pausing once per remaining app.
  let pausesRemaining = rateLimitRetries;
  let pausesTaken = 0;

  // Resolves to { details } or { error }; a rate-limited request is retried
  // after a pause while the run's pause budget lasts.
  async function fetchDetails(appId) {
    for (;;) {
      try {
        return { details: await storeClient.app({ appId, country }) };
      } catch (error) {
        if (!isRateLimited(error) || pausesRemaining <= 0) return { error };

        pausesRemaining--;
        pausesTaken++;
        const pauseMs = rateLimitPauseMs(error, pausesTaken, rateLimitBackoffMs);
        logger.warn(
          `Apple rate limited ${appId}; pausing ${Math.round(pauseMs / 1000)}s`
          + ` before retrying (${pausesRemaining} pause(s) left)`
        );
        await sleepFn(pauseMs);
      }
    }
  }

  for (const [index, row] of selected.rows.entries()) {
    if (index > 0 && delayMs > 0) await sleepFn(delayMs);
    await markAttempt(client, row.appid);

    const { details, error } = await fetchDetails(row.appid);

    if (!error) {
      await recordSuccess(client, details, new Date());
      refreshed++;
      consecutiveFailures = 0;
      logger.log(`Refreshed ${row.appid}`);
    } else {
      const absent = isAppAbsent(error);
      const message = errorMessage(error, absent);

      // A 403 or 429 describes this client, not the app that happened to be
      // next in the queue, so once the pause budget is spent the run stops
      // without recording a failure that would push an innocent app into
      // exponential backoff.
      if (isRateLimited(error)) {
        failed++;
        const retryAfter = error && error.retryAfter;
        stoppedReason = `Apple request stop signal: ${message}`
          + (retryAfter ? ` (retry-after: ${retryAfter})` : '')
          + (pausesTaken ? ` after ${pausesTaken} pause(s)` : '');
        logger.warn(`Refresh stopped at ${row.appid}: ${stoppedReason}`);
        break;
      }

      await recordFailure(client, row.appid, message);
      failed++;
      logger.warn(`Refresh failed for ${row.appid}: ${message}`);

      if (absent) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          stoppedReason = '5 consecutive transport failures';
          break;
        }
      }
    }
  }

  return {
    selected: selected.rows,
    attempted: refreshed + failed,
    refreshed,
    failed,
    pauses: pausesTaken,
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
  isRateLimited,
  retryAfterMs,
  rateLimitPauseMs,
  refreshAppStoreMetadata,
  main
};
