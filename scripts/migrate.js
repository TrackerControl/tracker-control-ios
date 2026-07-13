#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

// Two signed 32-bit integers identifying this application's migration runner.
// PostgreSQL advisory locks are database-scoped, so concurrent app instances
// sharing a database will serialize on the same key.
const MIGRATION_LOCK_KEYS = [1414677323, 1296648018]; // "TRCK", "MIGR"

async function runMigrations(client, migrationsDir, logger = console) {
  let lockHeld = false;

  logger.log('Waiting for migration advisory lock');
  const waitStartedAt = Date.now();
  await client.query(
    'SELECT pg_advisory_lock($1, $2)',
    MIGRATION_LOCK_KEYS
  );
  lockHeld = true;
  logger.log(`Acquired migration advisory lock after ${Date.now() - waitStartedAt}ms`);

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamp without time zone NOT NULL DEFAULT NOW()
      )
    `);

    // File discovery belongs inside the lock so every runner observes the
    // migration history left by the previous lock holder.
    const files = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const applied = await client.query('SELECT filename FROM schema_migrations');
    const appliedFiles = new Set(applied.rows.map((row) => row.filename));

    for (const file of files) {
      if (appliedFiles.has(file)) {
        logger.log(`Skipping ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      logger.log(`Applying ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (lockHeld) {
      logger.log('Releasing migration advisory lock');
      await client.query(
        'SELECT pg_advisory_unlock($1, $2)',
        MIGRATION_LOCK_KEYS
      );
      logger.log('Released migration advisory lock');
    }
  }
}

async function main({
  databaseUrl = process.env.DATABASE_URL,
  migrationsDir = path.join(__dirname, '..', 'migrations'),
  ClientClass = Client,
  logger = console
} = {}) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Configure .env or analyser/.env.');
  }

  const client = new ClientClass({ connectionString: databaseUrl });
  try {
    await client.connect();
    await runMigrations(client, migrationsDir, logger);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  MIGRATION_LOCK_KEYS,
  main,
  runMigrations
};
