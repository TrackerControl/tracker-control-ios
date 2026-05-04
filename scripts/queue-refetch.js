#!/usr/bin/env node

const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const failed = args.has('--failed');
const appIds = process.argv
  .slice(2)
  .filter((arg) => arg.startsWith('--appid='))
  .map((arg) => arg.slice('--appid='.length))
  .filter(Boolean);

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 20) : 20;

const reviewsExpr = `
  CASE
    WHEN details->>'reviews' ~ '^[0-9]+$' THEN (details->>'reviews')::integer
    ELSE 0
  END
`;

async function ensureHistoryTable(client) {
  const result = await client.query("SELECT to_regclass('public.app_analyses') AS table_name");
  if (!result.rows[0].table_name) {
    throw new Error('app_analyses does not exist. Run npm run migrate before queueing refetches.');
  }
}

async function snapshotCurrentAnalysis(client, appId) {
  await client.query(`
    INSERT INTO app_analyses (
      appid,
      analysis,
      analysisversion,
      analysed,
      app_version,
      app_store_updated,
      analysis_source,
      success
    )
    SELECT
      appid,
      analysis,
      analysisversion,
      COALESCE(analysed, NOW()),
      details->>'version',
      NULLIF(details->>'updated', '')::timestamp,
      COALESCE(analysis->>'analysis_source', 'legacy'),
      COALESCE((analysis->>'success')::boolean, true)
    FROM apps
    WHERE appid = $1
      AND analysis IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM app_analyses existing
        WHERE existing.appid = apps.appid
          AND existing.analysed = COALESCE(apps.analysed, NOW())
      )
  `, [appId]);
}

function printRows(rows) {
  for (const [index, row] of rows.entries()) {
    const reviews = Number(row.reviews || 0).toLocaleString('en-US');
    const analysed = row.analysed ? new Date(row.analysed).toISOString().slice(0, 10) : 'n/a';
    console.log(`${index + 1}. ${row.title || row.appid} (${row.appid}) - ${reviews} reviews, analysed ${analysed}`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Configure .env or analyser/.env.');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let rows;
  if (appIds.length > 0) {
    const result = await client.query(`
      SELECT appid, details->>'title' AS title, ${reviewsExpr} AS reviews, analysed
      FROM apps
      WHERE appid = ANY($1)
      ORDER BY ${reviewsExpr} DESC
    `, [appIds]);
    rows = result.rows;

    const found = new Set(rows.map((row) => row.appid));
    for (const appId of appIds) {
      if (!found.has(appId)) {
        console.warn(`App not found: ${appId}`);
      }
    }
  } else {
    const where = failed
      ? "analysis->>'success' = 'false' AND coalesce(analysis->>'logs', '') <> 'Processing in progress'"
      : "analysis IS NOT NULL AND coalesce(analysis->>'success', 'true') <> 'false'";

    const result = await client.query(`
      SELECT appid, details->>'title' AS title, ${reviewsExpr} AS reviews, analysed
      FROM apps
      WHERE ${where}
      ORDER BY ${reviewsExpr} DESC, analysed ASC
      LIMIT $1
    `, [limit]);
    rows = result.rows;
  }

  if (!apply) {
    console.log('Dry run. Add --apply to clear apps.analysis and queue these apps for refetch.');
    printRows(rows);
    await client.end();
    return;
  }

  await ensureHistoryTable(client);
  await client.query('BEGIN');
  try {
    for (const row of rows) {
      await snapshotCurrentAnalysis(client, row.appid);
      await client.query(
        'UPDATE apps SET analysis = NULL, analysisversion = NULL, analysed = NULL WHERE appid = $1',
        [row.appid]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  console.log(`Queued ${rows.length} apps for refetch.`);
  printRows(rows);
  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
