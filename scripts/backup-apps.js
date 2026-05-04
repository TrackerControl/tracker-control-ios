#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Configure .env or analyser/.env.');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const columns = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'apps'
    ORDER BY ordinal_position
  `);

  const constraints = await client.query(`
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'apps'::regclass
    ORDER BY conname
  `);

  const indexes = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'apps'
    ORDER BY indexname
  `);

  const apps = await client.query('SELECT * FROM apps ORDER BY appid');

  let analyses = { rows: [], rowCount: 0 };
  const historyTable = await client.query("SELECT to_regclass('public.app_analyses') AS table_name");
  if (historyTable.rows[0].table_name) {
    analyses = await client.query('SELECT * FROM app_analyses ORDER BY appid, analysed, id');
  }

  await client.end();

  const backup = {
    createdAt: new Date().toISOString(),
    tables: {
      apps: {
        rowCount: apps.rowCount,
        columns: columns.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
        rows: apps.rows
      },
      app_analyses: {
        rowCount: analyses.rowCount,
        rows: analyses.rows
      }
    }
  };

  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const out = path.join(backupDir, `apps-backup-${timestamp()}.json`);
  fs.writeFileSync(out, `${JSON.stringify(backup, null, 2)}\n`);

  console.log(out);
  console.log(`${apps.rowCount} apps rows`);
  console.log(`${analyses.rowCount} app_analyses rows`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
