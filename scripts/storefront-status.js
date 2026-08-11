#!/usr/bin/env node

'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { withAdvisoryLock } = require('../lib/jobLock');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

const STATUS_LOCK_KEYS = [1414677323, 1380992851]; // "TRCK", "STAT"

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    staleDays: positiveInteger(env.METADATA_STATUS_STALE_DAYS, 30)
  };
  for (const arg of argv) {
    if (arg.startsWith('--stale-days=')) options.staleDays = positiveInteger(arg.slice(13), options.staleDays);
    else if (arg === '--help') {
      console.log('Usage: pnpm storefront-status [--stale-days=30]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function buildStatusQuery() {
  return {
    text: `
      SELECT
        COUNT(*)::integer AS total,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM apps WHERE lower(appid) = cache.appid_key
        ))::integer AS referenced,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM apps WHERE lower(appid) = cache.appid_key
        ))::integer AS unreferenced,
        COUNT(*) FILTER (WHERE cache.fetched_at < NOW() - ($1::integer * INTERVAL '1 day'))::integer AS stale,
        COUNT(*) FILTER (WHERE cache.refresh_failures > 0)::integer AS failing,
        MIN(cache.fetched_at) AS oldest_successful_refresh,
        MAX(cache.fetched_at) AS newest_successful_refresh,
        pg_total_relation_size('app_store_cache')::bigint AS relation_size
      FROM app_store_cache cache
    `
  };
}

async function storefrontStatus(client, options = {}) {
  const { staleDays = 30, logger = console } = options;
  const summary = await client.query(buildStatusQuery().text, [staleDays]);
  const failures = await client.query(`
    SELECT appid_key, refresh_failures, refresh_attempted_at, refresh_error
    FROM app_store_cache
    WHERE refresh_failures > 0
    ORDER BY refresh_attempted_at DESC NULLS LAST, appid_key
  `);
  const result = { summary: summary.rows[0], failures: failures.rows };
  logger.log(JSON.stringify(result, null, 2));
  return result;
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
      STATUS_LOCK_KEYS,
      () => storefrontStatus(client, options),
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
  STATUS_LOCK_KEYS,
  parseArgs,
  buildStatusQuery,
  storefrontStatus,
  main
};
