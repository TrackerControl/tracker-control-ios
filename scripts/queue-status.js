#!/usr/bin/env node

const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

const currentAnalysisVersion = parseInt(process.env.CURRENT_ANALYSIS_VERSION || process.env.ANALYSIS_VERSION || '3', 10);
const staleAnalysisDays = parseInt(process.env.STALE_ANALYSIS_DAYS || '180', 10);
const processingTimeoutMinutes = parseInt(process.env.PROCESSING_TIMEOUT_MINUTES || '120', 10);

const reviewsExpr = `
  CASE
    WHEN details->>'reviews' ~ '^[0-9]+$' THEN (details->>'reviews')::integer
    ELSE 0
  END
`;

function pct(part, total) {
  if (!total) return '0.0%';
  return `${(part / total * 100).toFixed(1)}%`;
}

function int(value) {
  return Number(value || 0);
}

function fmt(value) {
  return int(value).toLocaleString('en-US');
}

function iso(value) {
  return value ? new Date(value).toISOString() : 'n/a';
}

function eta(backlog, perDay) {
  if (!backlog || !perDay) return 'n/a';
  const days = backlog / perDay;
  if (days < 2) return `${days.toFixed(1)} days`;
  if (days < 60) return `${Math.ceil(days)} days`;
  return `${(days / 30).toFixed(1)} months`;
}

function rate(row, key, days) {
  return int(row[key]) / days;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Configure .env or analyser/.env.');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const summaryResult = await client.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE analysis IS NULL)::int AS never_or_reset,
      count(*) FILTER (
        WHERE analysis->>'logs' = 'Processing in progress'
          AND (analysis->>'timestamp')::timestamptz >= NOW() - ($3::int * INTERVAL '1 minute')
      )::int AS active_processing,
      count(*) FILTER (
        WHERE analysis->>'logs' = 'Processing in progress'
          AND (analysis->>'timestamp')::timestamptz < NOW() - ($3::int * INTERVAL '1 minute')
      )::int AS expired_processing,
      count(*) FILTER (
        WHERE analysis IS NOT NULL
          AND coalesce(analysis->>'logs', '') <> 'Processing in progress'
          AND coalesce(analysis->>'success', 'true') = 'false'
      )::int AS failed,
      count(*) FILTER (
        WHERE analysis IS NOT NULL
          AND coalesce(analysis->>'logs', '') <> 'Processing in progress'
          AND coalesce(analysis->>'success', 'true') <> 'false'
      )::int AS analysed_success,
      count(*) FILTER (
        WHERE analysis IS NOT NULL
          AND coalesce(analysis->>'logs', '') <> 'Processing in progress'
          AND coalesce(analysis->>'success', 'true') <> 'false'
          AND analysisversion = $1
          AND analysed >= NOW() - ($2::int * INTERVAL '1 day')
      )::int AS fresh_success,
      count(*) FILTER (
        WHERE analysis IS NOT NULL
          AND coalesce(analysis->>'logs', '') <> 'Processing in progress'
          AND coalesce(analysis->>'success', 'true') <> 'false'
          AND (
            analysisversion IS DISTINCT FROM $1
            OR analysed < NOW() - ($2::int * INTERVAL '1 day')
          )
      )::int AS stale_success,
      count(*) FILTER (
        WHERE coalesce(analysis->>'retryable', 'true') <> 'false'
          AND (
            analysis IS NULL
            OR (
              analysis->>'logs' = 'Processing in progress'
              AND (analysis->>'timestamp')::timestamptz < NOW() - ($3::int * INTERVAL '1 minute')
            )
            OR (
              coalesce(analysis->>'logs', '') <> 'Processing in progress'
              AND (
                analysisversion IS DISTINCT FROM $1
                OR analysed < NOW() - ($2::int * INTERVAL '1 day')
              )
            )
          )
      )::int AS queue_backlog,
      count(*) FILTER (WHERE analysed >= NOW() - INTERVAL '1 hour')::int AS analysed_1h,
      count(*) FILTER (WHERE analysed >= NOW() - INTERVAL '24 hours')::int AS analysed_24h,
      count(*) FILTER (WHERE analysed >= NOW() - INTERVAL '7 days')::int AS analysed_7d,
      max(analysed) AS newest_analysed,
      min(analysed) FILTER (WHERE analysed IS NOT NULL) AS oldest_analysed
    FROM apps
  `, [currentAnalysisVersion, staleAnalysisDays, processingTimeoutMinutes]);

  const processingResult = await client.query(`
    SELECT
      appid,
      details->>'title' AS title,
      (analysis->>'timestamp')::timestamptz AS started_at,
      EXTRACT(EPOCH FROM (NOW() - (analysis->>'timestamp')::timestamptz))::int AS age_seconds
    FROM apps
    WHERE analysis->>'logs' = 'Processing in progress'
    ORDER BY started_at ASC
    LIMIT 10
  `);

  const topBacklogResult = await client.query(`
    SELECT
      appid,
      details->>'title' AS title,
      ${reviewsExpr} AS reviews,
      CASE
        WHEN analysis IS NULL THEN 'never analysed/reset'
        WHEN analysis->>'logs' = 'Processing in progress' THEN 'expired processing'
        WHEN analysisversion IS DISTINCT FROM $1 THEN 'old analysis version'
        ELSE 'stale by age'
      END AS reason
    FROM apps
    WHERE analysis IS NULL
      OR (
        analysis->>'logs' = 'Processing in progress'
        AND (analysis->>'timestamp')::timestamptz < NOW() - ($3::int * INTERVAL '1 minute')
      )
      OR (
        coalesce(analysis->>'logs', '') <> 'Processing in progress'
        AND (
          analysisversion IS DISTINCT FROM $1
          OR analysed < NOW() - ($2::int * INTERVAL '1 day')
        )
      )
    ORDER BY ${reviewsExpr} DESC, added ASC
    LIMIT 10
  `, [currentAnalysisVersion, staleAnalysisDays, processingTimeoutMinutes]);

  const row = summaryResult.rows[0];
  const total = int(row.total);
  const backlog = int(row.queue_backlog);
  const perDay24 = rate(row, 'analysed_24h', 1);
  const perDay7 = rate(row, 'analysed_7d', 7);

  console.log('Analysis queue status');
  console.log('=====================');
  console.log(`Total apps: ${fmt(total)}`);
  console.log(`Fresh successful analyses: ${fmt(row.fresh_success)} (${pct(row.fresh_success, total)})`);
  console.log(`Successful but stale: ${fmt(row.stale_success)} (${pct(row.stale_success, total)})`);
  console.log(`Never analysed / manually reset: ${fmt(row.never_or_reset)} (${pct(row.never_or_reset, total)})`);
  console.log(`Failed analyses: ${fmt(row.failed)} (${pct(row.failed, total)})`);
  console.log(`Active processing markers: ${fmt(row.active_processing)}`);
  console.log(`Expired processing markers: ${fmt(row.expired_processing)}`);
  console.log(`Queue backlog by current policy: ${fmt(row.queue_backlog)} (${pct(row.queue_backlog, total)})`);
  console.log(`Newest analysis: ${iso(row.newest_analysed)}`);
  console.log(`Oldest retained analysis: ${iso(row.oldest_analysed)}`);
  console.log(`Policy: version=${currentAnalysisVersion}, stale>${staleAnalysisDays}d, processing timeout=${processingTimeoutMinutes}m`);

  console.log('\nThroughput');
  console.log('==========');
  console.log(`Analysed last hour: ${fmt(row.analysed_1h)}`);
  console.log(`Analysed last 24h: ${fmt(row.analysed_24h)} (${perDay24.toFixed(1)}/day)`);
  console.log(`Analysed last 7d: ${fmt(row.analysed_7d)} (${perDay7.toFixed(1)}/day)`);
  console.log(`ETA at 24h rate: ${eta(backlog, perDay24)}`);
  console.log(`ETA at 7d rate: ${eta(backlog, perDay7)}`);

  console.log('\nCurrently processing');
  console.log('====================');
  if (processingResult.rows.length === 0) {
    console.log('No active or expired processing markers.');
  } else {
    for (const item of processingResult.rows) {
      const minutes = Math.round(int(item.age_seconds) / 60);
      console.log(`- ${item.title || item.appid} (${item.appid}), started ${iso(item.started_at)}, age ${minutes}m`);
    }
  }

  console.log('\nTop backlog');
  console.log('===========');
  if (topBacklogResult.rows.length === 0) {
    console.log('No backlog under current policy.');
  } else {
    for (const [index, item] of topBacklogResult.rows.entries()) {
      console.log(`${index + 1}. ${item.title || item.appid} (${item.appid}) - ${fmt(item.reviews)} reviews, ${item.reason}`);
    }
  }

  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
