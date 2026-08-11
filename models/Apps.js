const { Pool } = require('pg');
const crypto = require('crypto');
const {
    APP_ID_PATTERN_SOURCE,
    MAX_APP_ID_LENGTH,
    isValidAppId,
    isSameAppId,
    appIdSqlPredicate
} = require('../lib/appId');
// index.js runs dotenv.config() before requiring this module (via server.js),
// so process.env is already populated by the time analysisPolicy is read.
const {
    CURRENT_ANALYSIS_VERSION,
    STALE_ANALYSIS_DAYS,
    PROCESSING_TIMEOUT_MINUTES
} = require('../lib/analysisPolicy');
const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {}
);

const configuredCacheRetentionDays = Number.parseInt(
    process.env.APP_STORE_CACHE_RETENTION_DAYS || '90',
    10
);
const APP_STORE_CACHE_RETENTION_DAYS = Number.isInteger(configuredCacheRetentionDays)
    && configuredCacheRetentionDays > 0
    ? configuredCacheRetentionDays
    : 90;

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
});

// Derive the scheduling-state columns from an analyser payload.
// A payload with success === false is a failure; everything else is a
// successful analysis. Kept as a pure, exported helper so the mapping can be
// unit-tested without a database.
function deriveAnalysisState(analysis) {
    if (analysis && analysis.success === false) {
        return {
            status: 'failed',
            failureReason: (analysis.reason || analysis.logs) || null,
            failureRetryable: analysis.retryable !== false
        };
    }
    return {
        status: 'analysed',
        failureReason: null,
        failureRetryable: null
    };
}

const ANALYSIS_CLAIM_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidAnalysisClaimToken(value) {
    return typeof value === 'string' && ANALYSIS_CLAIM_TOKEN_PATTERN.test(value);
}

function canonicalAppId(appId, details) {
    if (!isValidAppId(appId)) throw new TypeError('Invalid App Store bundle ID');
    if (!details || !isValidAppId(details.appId) || !isSameAppId(details.appId, appId)) {
        throw new TypeError('App Store bundle ID mismatch');
    }
    return details.appId;
}

const ANALYSIS_PROVENANCE_COLUMNS = Object.freeze([
    'app_version',
    'app_store_updated',
    'storefront_details',
    'storefront_fetched_at'
]);

// Keep every analysis-history writer on the same source-selection rule. The
// analysis expression is configurable because the live writer receives its
// payload as a query parameter while refetch/replay snapshot the apps row.
function buildAnalysisProvenanceSourceSql({
    appsAlias = 'apps',
    analysisExpression = `${appsAlias}.analysis`,
    cacheAlias = 'storefront_cache'
} = {}) {
    const analysis = `(${analysisExpression})`;
    return {
        columns: [...ANALYSIS_PROVENANCE_COLUMNS],
        join: `LEFT JOIN app_store_cache ${cacheAlias}
            ON ${cacheAlias}.appid_key = lower(${appsAlias}.appid)`,
        select: {
            appVersion: `COALESCE(${analysis}->>'version', ${appsAlias}.details->>'version')`,
            appStoreUpdated: `NULLIF(COALESCE(
                NULLIF(${cacheAlias}.details->>'updated', ''),
                ${appsAlias}.details->>'updated'
            ), '')::timestamp`,
            storefrontDetails: `COALESCE(
                ${cacheAlias}.details,
                ${appsAlias}.details::jsonb
            )`,
            storefrontFetchedAt: `COALESCE(
                ${cacheAlias}.fetched_at,
                ${appsAlias}.added
            )`
        }
    };
}

const lastAnalysed = async () => {
    const result = await pool.query("SELECT * FROM apps WHERE status = 'analysed' ORDER BY analysed DESC LIMIT 5");
    return result.rows;
}

const healthCheck = async () => {
    await pool.query('SELECT 1');
}

const findApp = async (appId) => {
    if (!isValidAppId(appId)) return null;

    const result = await pool.query(`
        SELECT
            apps.*,
            history.app_version AS analysis_app_version,
            history.storefront_details AS analysis_storefront_details,
            history.storefront_fetched_at AS analysis_storefront_fetched_at,
            cache.details AS current_storefront_details,
            cache.fetched_at AS current_fetched_at
        FROM apps
        LEFT JOIN app_analyses history
            ON history.appid = apps.appid
            AND (
                history.analysed IS NOT DISTINCT FROM apps.analysed
                OR (
                    apps.analysed IS NULL
                    AND apps.analysis IS NOT NULL
                    AND history.analysed = apps.added
                )
            )
        LEFT JOIN app_store_cache cache
            ON cache.appid_key = lower(apps.appid)
        WHERE lower(apps.appid) = lower($1)
    `, [appId]);
    if (result.rows.length == 0)
        return null;

    return result.rows[0];
}

function buildAppStoreCacheUpsert(results, fetchedAt = null) {
    const entriesByKey = new Map();
    for (const details of results || []) {
        if (!details || !isValidAppId(details.appId)) continue;
        entriesByKey.set(details.appId.toLowerCase(), details);
    }

    const entries = [...entriesByKey.entries()];
    if (entries.length === 0) return null;

    const values = [];
    const placeholders = entries.map(([appidKey, details], index) => {
        const offset = index * (fetchedAt === null ? 2 : 3);
        values.push(appidKey, details);
        if (fetchedAt !== null) values.push(fetchedAt);
        const fetchedAtValue = fetchedAt === null
            ? 'NOW()'
            : `$${offset + 3}::timestamptz`;
        return `($${offset + 1}, $${offset + 2}, ${fetchedAtValue})`;
    });

    return {
        text: `
        INSERT INTO app_store_cache AS existing (appid_key, details, fetched_at)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (appid_key) DO UPDATE
        SET details = EXCLUDED.details,
            fetched_at = EXCLUDED.fetched_at,
            refresh_attempted_at = existing.refresh_attempted_at,
            refresh_failures = 0,
            refresh_error = NULL
    `,
        values
    };
}

function buildAppStoreCachePrune() {
    return {
        text: `
        DELETE FROM app_store_cache cache
        WHERE cache.fetched_at < NOW() - ($1::integer * INTERVAL '1 day')
          AND NOT EXISTS (
              SELECT 1
              FROM apps
              WHERE lower(appid) = cache.appid_key
          )
    `,
        values: [APP_STORE_CACHE_RETENTION_DAYS]
    };
}

// Pruning is handled by the scheduled `pnpm prune-cache` / metadata-cron job
// (scripts/prune-app-store-cache.js), not inline on every cache write.
const cacheAppStoreResults = async (results, fetchedAt = new Date()) => {
    const query = buildAppStoreCacheUpsert(results, fetchedAt);
    if (query) await pool.query(query.text, query.values);
}

const findCachedAppStoreResult = async (appId) => {
    if (!isValidAppId(appId)) return null;

    const result = await pool.query(
        'SELECT details FROM app_store_cache WHERE appid_key = lower($1)',
        [appId]
    );
    return result.rows.length === 0 ? null : result.rows[0].details;
}

const countQueue = async (added) => {
    if (added) {
        const result = await pool.query(`
            SELECT COUNT(*)
            FROM apps
            WHERE status = 'queued'
                AND added < $1
                AND ${appIdSqlPredicate(2, 3)}
        `, [added, APP_ID_PATTERN_SOURCE, MAX_APP_ID_LENGTH]);
        return result.rows[0].count;
    } else {
        const result = await pool.query(`
            SELECT COUNT(*)
            FROM apps
            WHERE status = 'queued'
                AND ${appIdSqlPredicate(1, 2)}
        `, [APP_ID_PATTERN_SOURCE, MAX_APP_ID_LENGTH]);
        return result.rows[0].count;
    }
}

const addApp = async (appId, details) => {
    const canonicalId = canonicalAppId(appId, details);

    // Bare ON CONFLICT covers both the appid primary key and the
    // case-insensitive lower(appid) unique index from migration 009.
    const result = await pool.query('INSERT INTO apps (appid, details) VALUES ($1, $2) ON CONFLICT DO NOTHING', [canonicalId, details]);
    return result;
}

async function addAppWithStorefront(client, appId, details) {
    const canonicalId = canonicalAppId(appId, details);
    const result = await client.query(
        'INSERT INTO apps (appid, details) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [canonicalId, details]
    );

    const cacheQuery = buildAppStoreCacheUpsert([details], new Date());
    if (cacheQuery) await client.query(cacheQuery.text, cacheQuery.values);
    return result;
}

async function addAppAndStorefront(appId, details) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await addAppWithStorefront(client, appId, details);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

const popularityExpression = `
    CASE
        WHEN details->>'reviews' ~ '^[0-9]+$' THEN (details->>'reviews')::integer
        ELSE 0
    END`;

const currentAnalysisVersion = CURRENT_ANALYSIS_VERSION;
const staleAnalysisDays = STALE_ANALYSIS_DAYS;
const processingTimeoutMinutes = PROCESSING_TIMEOUT_MINUTES;

const nextApp = async (requestedAppId = null) => {
    if (requestedAppId !== null && !isValidAppId(requestedAppId)) {
        throw new TypeError('Invalid App Store bundle ID');
    }

    const claimToken = crypto.randomUUID();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Candidate selection keys off the real status columns instead of the
        // analysis JSON. The lock is non-destructive: we flip status to
        // 'processing' and stamp processing_started, but leave the analysis
        // payload alone so the last good result stays visible on the website
        // while a refetch is in flight. History snapshots happen in
        // updateAnalysis when the new result lands.
        const candidate = await client.query(`
            SELECT appid
            FROM apps
            WHERE ${appIdSqlPredicate(4, 5)}
                AND ($6::text IS NULL OR lower(appid) = lower($6::text))
                AND (
                    status = 'queued'
                    OR (
                        status = 'processing'
                        AND processing_started < NOW() - ($3::int * INTERVAL '1 minute')
                    )
                    OR (
                        status = 'analysed'
                        AND (
                            analysisversion IS DISTINCT FROM $1
                            OR analysed < NOW() - ($2::int * INTERVAL '1 day')
                        )
                    )
                    OR (
                        status = 'failed'
                        AND failure_retryable
                        AND (
                            analysisversion IS DISTINCT FROM $1
                            OR analysed < NOW() - ($2::int * INTERVAL '1 day')
                        )
                    )
                )
            ORDER BY ${popularityExpression} DESC, added ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `, [
            currentAnalysisVersion,
            staleAnalysisDays,
            processingTimeoutMinutes,
            APP_ID_PATTERN_SOURCE,
            MAX_APP_ID_LENGTH,
            requestedAppId
        ]);

        if (candidate.rowCount === 0) {
            await client.query('COMMIT');
            return null;
        }

        const result = await client.query(`
            UPDATE apps
            SET status = 'processing',
                processing_started = NOW(),
                analysis_claim_token = $2
            WHERE appid = $1
            RETURNING appid, analysis_claim_token
        `, [candidate.rows[0].appid, claimToken]);

        await client.query('COMMIT');

        console.log('Processing started for app:', result.rows[0].appid);
        return result.rows[0];
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

const updateAnalysisWithClient = async (client, appId, analysis, analysisVersion, claimToken) => {
    if (!isValidAppId(appId)) throw new TypeError('Invalid App Store bundle ID');
    if (!isValidAnalysisClaimToken(claimToken)) throw new TypeError('Invalid analysis claim token');

    const { status, failureReason, failureRetryable } = deriveAnalysisState(analysis);

    // The token comparison is the completion CAS: a timed-out worker cannot
    // update a row after nextApp has issued a new token, and a reset/replay
    // invalidates the claim by clearing it.
    const result = await client.query(
        `UPDATE apps
         SET analysis = $1,
             analysisVersion = $2,
             analysed = NOW(),
             status = $4,
             failure_reason = $5,
             failure_retryable = $6,
             processing_started = NULL,
             analysis_claim_token = NULL
         WHERE appid = $3
             AND status = 'processing'
             AND analysis_claim_token = $7
         RETURNING appid, details, analysed`,
        [analysis, analysisVersion, appId, status, failureReason, failureRetryable, claimToken]
    );

    if (result.rowCount > 0) {
        const app = result.rows[0];
        const provenance = buildAnalysisProvenanceSourceSql({
            analysisExpression: '$2::jsonb'
        });
        await client.query(`
            INSERT INTO app_analyses (
                appid,
                analysis,
                analysisversion,
                analysed,
                ${provenance.columns.join(',\n                ')},
                analysis_source,
                success
            )
            SELECT
                $1,
                $2,
                $3,
                $4,
                ${provenance.select.appVersion},
                ${provenance.select.appStoreUpdated},
                ${provenance.select.storefrontDetails},
                ${provenance.select.storefrontFetchedAt},
                $5,
                $6
            FROM apps
            ${provenance.join}
            WHERE apps.appid = $1
            ON CONFLICT (appid, analysed) DO NOTHING
        `, [
            app.appid,
            analysis,
            analysisVersion,
            app.analysed,
            analysis && typeof analysis.analysis_source === 'string' && analysis.analysis_source
                ? analysis.analysis_source
                : 'legacy',
            !(analysis && analysis.success === false)
        ]);
    }

    return result;
}

const updateAnalysis = async (appId, analysis, analysisVersion, claimToken) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await updateAnalysisWithClient(client, appId, analysis, analysisVersion, claimToken);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

const getAllApps = async () => {
    const result = await pool.query("SELECT * FROM apps WHERE status = 'analysed'");
    return result.rows;
}

const getSiteDataSignature = async () => {
    const result = await pool.query(`
        SELECT
            COUNT(*) FILTER (
                WHERE status = 'analysed'
                    AND analysis->'trackers' IS NOT NULL
            ) AS app_count,
            MAX(analysed) FILTER (
                WHERE status = 'analysed'
                    AND analysis->'trackers' IS NOT NULL
            ) AS latest_analysis
        FROM apps
    `);

    const row = result.rows[0];
    return {
        appCount: parseInt(row.app_count, 10),
        latestAnalysis: row.latest_analysis ? new Date(row.latest_analysis).toISOString() : null
    };
}

const countAnalysed = async () => {
    const result = await pool.query("SELECT COUNT(*) FROM apps WHERE status = 'analysed'");
    return parseInt(result.rows[0].count, 10);
}

module.exports = {
    lastAnalysed,
    findApp,
    cacheAppStoreResults,
    findCachedAppStoreResult,
    countQueue,
    countAnalysed,
    addApp,
    nextApp,
    updateAnalysis,
    getAllApps,
    getSiteDataSignature,
    healthCheck,
    deriveAnalysisState,
    canonicalAppId,
    APP_STORE_CACHE_RETENTION_DAYS,
    buildAppStoreCacheUpsert,
    buildAppStoreCachePrune,
    ANALYSIS_PROVENANCE_COLUMNS,
    buildAnalysisProvenanceSourceSql,
    isValidAnalysisClaimToken,
    updateAnalysisWithClient,
    addAppWithStorefront,
    addAppAndStorefront
}
