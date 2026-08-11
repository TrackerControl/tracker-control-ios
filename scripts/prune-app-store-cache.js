#!/usr/bin/env node

'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { withAdvisoryLock } = require('../lib/jobLock');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

const PRUNE_LOCK_KEYS = [1414677323, 1380992850]; // "TRCK", "PRUN"

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    retentionDays: positiveInteger(env.APP_STORE_CACHE_RETENTION_DAYS, 90),
    maxUnreferenced: positiveInteger(env.APP_STORE_CACHE_MAX_UNREFERENCED, 50000),
    dryRun: false
  };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--retention-days=')) {
      options.retentionDays = positiveInteger(arg.slice(17), options.retentionDays);
    } else if (arg.startsWith('--max-unreferenced=')) {
      options.maxUnreferenced = positiveInteger(arg.slice(19), options.maxUnreferenced);
    } else if (arg === '--help') {
      console.log([
        'Usage: pnpm prune-cache [options]',
        '',
        '  --retention-days=90       Delete unreferenced rows older than this',
        '  --max-unreferenced=50000  Keep at most this many unreferenced rows',
        '  --dry-run                 Report counts without deleting'
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function buildRetentionPruneQuery() {
  return {
    text: `
      DELETE FROM app_store_cache cache
      WHERE cache.fetched_at < NOW() - ($1::integer * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1
          FROM apps
          WHERE lower(appid) = cache.appid_key
        )
    `
  };
}

function buildLruPruneQuery(maxUnreferenced) {
  return {
    text: `
      DELETE FROM app_store_cache cache
      WHERE cache.appid_key IN (
        SELECT candidates.appid_key
        FROM app_store_cache candidates
        WHERE NOT EXISTS (
          SELECT 1
          FROM apps
          WHERE lower(appid) = candidates.appid_key
        )
        ORDER BY candidates.fetched_at ASC
        OFFSET $1
      )
    `,
    values: [maxUnreferenced]
  };
}

async function countUnreferenced(client) {
  const result = await client.query(`
    SELECT COUNT(*)::integer AS count
    FROM app_store_cache cache
    WHERE NOT EXISTS (
      SELECT 1
      FROM apps
      WHERE lower(appid) = cache.appid_key
    )
  `);
  return Number(result.rows[0].count);
}

async function pruneAppStoreCache(client, options = {}) {
  const {
    retentionDays = 90,
    maxUnreferenced = 50000,
    dryRun = false,
    logger = console
  } = options;

  if (dryRun) {
    const unreferenced = await countUnreferenced(client);
    logger.log(`Unreferenced cache rows: ${unreferenced}`);
    return { retentionDeleted: 0, lruDeleted: 0, unreferenced };
  }

  const retention = buildRetentionPruneQuery();
  const retentionResult = await client.query(retention.text, [retentionDays]);
  const lru = buildLruPruneQuery(maxUnreferenced);
  const lruResult = await client.query(lru.text, lru.values);
  const unreferenced = await countUnreferenced(client);

  logger.log(`Pruned ${retentionResult.rowCount} expired and ${lruResult.rowCount} LRU cache rows.`);
  return {
    retentionDeleted: retentionResult.rowCount,
    lruDeleted: lruResult.rowCount,
    unreferenced
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
      PRUNE_LOCK_KEYS,
      () => pruneAppStoreCache(client, options),
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
  PRUNE_LOCK_KEYS,
  parseArgs,
  buildRetentionPruneQuery,
  buildLruPruneQuery,
  pruneAppStoreCache,
  main
};
