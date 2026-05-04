#!/usr/bin/env node

const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 20) : 20;
const currentAnalysisVersion = parseInt(process.env.CURRENT_ANALYSIS_VERSION || process.env.ANALYSIS_VERSION || '3', 10);
const staleAnalysisDays = parseInt(process.env.STALE_ANALYSIS_DAYS || '180', 10);

const reviewsExpr = `
  CASE
    WHEN details->>'reviews' ~ '^[0-9]+$' THEN (details->>'reviews')::integer
    ELSE 0
  END
`;

const queueCandidateWhere = `
  analysis IS NULL
    OR (
      coalesce(analysis->>'logs', '') <> 'Processing in progress'
      AND (
        analysisversion IS DISTINCT FROM $1
        OR analysed < NOW() - ($2::int * INTERVAL '1 day')
      )
    )
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
    const reason = row.reason ? `, ${row.reason}` : '';

    console.log(
      `${String(index + 1).padStart(2, ' ')}. ${titleText} (${row.appid}) - ${reviews} reviews, score ${score}, ${genre}, ${dateField} ${dateValue}${reason}`
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
      count(*) FILTER (
        WHERE analysis IS NOT NULL
          AND coalesce(analysis->>'logs', '') <> 'Processing in progress'
          AND (
            analysisversion IS DISTINCT FROM $1
            OR analysed < NOW() - ($2::int * INTERVAL '1 day')
          )
      )::int AS stale,
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
  `, [currentAnalysisVersion, staleAnalysisDays]);

  const nextApps = await client.query(`
    SELECT
      appid,
      details->>'title' AS title,
      details->>'primaryGenre' AS genre,
      ${reviewsExpr} AS reviews,
      round((details->>'score')::numeric, 2) AS score,
      CASE
        WHEN analysis IS NULL THEN 'never analysed'
        WHEN analysisversion IS DISTINCT FROM $1 THEN 'old analysis version'
        ELSE 'older than stale cutoff'
      END AS reason,
      coalesce(analysed, added) AS queue_date
    FROM apps
    WHERE ${queueCandidateWhere}
    ORDER BY ${reviewsExpr} DESC, added ASC
    LIMIT $3
  `, [currentAnalysisVersion, staleAnalysisDays, limit]);

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
  console.log(`Stale: ${summary.stale}`);
  console.log(`Processing markers: ${summary.processing}`);
  console.log(`Successful analyses: ${summary.successful}`);
  console.log(`Failed analyses: ${summary.failed}`);
  console.log(`Newest analysis: ${summary.newest_analysed ? new Date(summary.newest_analysed).toISOString() : 'n/a'}`);
  console.log(`Stale policy: analysisversion != ${currentAnalysisVersion} or analysed older than ${staleAnalysisDays} days`);

  printSection('Top apps /queue will analyse next', nextApps.rows, 'queue_date');
  printSection('Top failed apps to retry', failed.rows, 'analysed');

  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
