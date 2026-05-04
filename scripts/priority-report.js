#!/usr/bin/env node

const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 20) : 20;

const reviewsExpr = `
  CASE
    WHEN details->>'reviews' ~ '^[0-9]+$' THEN (details->>'reviews')::integer
    ELSE 0
  END
`;

function printSection(title, rows, dateField) {
  console.log(`\n${title}`);
  console.log('='.repeat(title.length));

  if (rows.length === 0) {
    console.log('No apps found.');
    return;
  }

  rows.forEach((row, index) => {
    const dateValue = row[dateField] ? new Date(row[dateField]).toISOString().slice(0, 10) : 'n/a';
    const titleText = row.title || row.appid;
    const genre = row.genre || 'Unknown';
    const score = row.score || 'n/a';
    const reviews = Number(row.reviews || 0).toLocaleString('en-US');

    console.log(
      `${String(index + 1).padStart(2, ' ')}. ${titleText} (${row.appid}) - ${reviews} reviews, score ${score}, ${genre}, ${dateField} ${dateValue}`
    );
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Configure .env or analyser/.env.');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const counts = await client.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE analysis IS NULL)::int AS queued,
      count(*) FILTER (WHERE analysis->>'logs' = 'Processing in progress')::int AS processing,
      count(*) FILTER (
        WHERE analysis->>'success' = 'false'
          AND coalesce(analysis->>'logs', '') <> 'Processing in progress'
      )::int AS failed,
      count(*) FILTER (
        WHERE analysis IS NOT NULL
          AND coalesce(analysis->>'success', 'true') <> 'false'
      )::int AS successful,
      max(analysed) AS newest_analysed
    FROM apps
  `);

  const queued = await client.query(`
    SELECT
      appid,
      details->>'title' AS title,
      details->>'primaryGenre' AS genre,
      ${reviewsExpr} AS reviews,
      round((details->>'score')::numeric, 2) AS score,
      added
    FROM apps
    WHERE analysis IS NULL
    ORDER BY ${reviewsExpr} DESC, added ASC
    LIMIT $1
  `, [limit]);

  const analysed = await client.query(`
    SELECT
      appid,
      details->>'title' AS title,
      details->>'primaryGenre' AS genre,
      ${reviewsExpr} AS reviews,
      round((details->>'score')::numeric, 2) AS score,
      analysed
    FROM apps
    WHERE analysis IS NOT NULL
      AND coalesce(analysis->>'success', 'true') <> 'false'
    ORDER BY ${reviewsExpr} DESC, analysed ASC
    LIMIT $1
  `, [limit]);

  const failed = await client.query(`
    SELECT
      appid,
      details->>'title' AS title,
      details->>'primaryGenre' AS genre,
      ${reviewsExpr} AS reviews,
      round((details->>'score')::numeric, 2) AS score,
      analysed
    FROM apps
    WHERE analysis->>'success' = 'false'
      AND coalesce(analysis->>'logs', '') <> 'Processing in progress'
    ORDER BY ${reviewsExpr} DESC, analysed ASC
    LIMIT $1
  `, [limit]);

  const summary = counts.rows[0];
  console.log('Database priority report');
  console.log('========================');
  console.log(`Total apps: ${summary.total}`);
  console.log(`Queued: ${summary.queued}`);
  console.log(`Processing markers: ${summary.processing}`);
  console.log(`Successful analyses: ${summary.successful}`);
  console.log(`Failed analyses: ${summary.failed}`);
  console.log(`Newest analysis: ${summary.newest_analysed ? new Date(summary.newest_analysed).toISOString() : 'n/a'}`);

  printSection('Top queued apps to analyse next', queued.rows, 'added');
  printSection('Top analysed apps to refetch', analysed.rows, 'analysed');
  printSection('Top failed apps to retry', failed.rows, 'analysed');

  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
