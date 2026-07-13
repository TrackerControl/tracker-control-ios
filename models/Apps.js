const { Pool } = require('pg');
const {
    APP_ID_PATTERN_SOURCE,
    MAX_APP_ID_LENGTH,
    isValidAppId
} = require('../lib/appId');
const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {}
);

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

const lastAnalysed = async () => {
    const result = await pool.query("SELECT * FROM apps WHERE status = 'analysed' ORDER BY analysed DESC LIMIT 5");
    return result.rows;
}

const healthCheck = async () => {
    await pool.query('SELECT 1');
}

const findApp = async (appId) => {
    if (!isValidAppId(appId)) return null;

    const result = await pool.query('SELECT * FROM apps WHERE lower(appid) = lower($1)', [appId]);
    if (result.rows.length == 0)
        return null;

    return result.rows[0];
}

const countQueue = async (added) => {
    if (added) {
        const result = await pool.query(`
            SELECT COUNT(*)
            FROM apps
            WHERE status = 'queued'
                AND added < $1
                AND appid ~ $2
                AND appid !~ '[.]$'
                AND length(appid) <= $3
        `, [added, APP_ID_PATTERN_SOURCE, MAX_APP_ID_LENGTH]);
        return result.rows[0].count;
    } else {
        const result = await pool.query(`
            SELECT COUNT(*)
            FROM apps
            WHERE status = 'queued'
                AND appid ~ $1
                AND appid !~ '[.]$'
                AND length(appid) <= $2
        `, [APP_ID_PATTERN_SOURCE, MAX_APP_ID_LENGTH]);
        return result.rows[0].count;
    }
}

const addApp = async (appId, details) => {
    if (!isValidAppId(appId)) throw new TypeError('Invalid App Store bundle ID');
    if (!details || details.appId !== appId) throw new TypeError('App Store bundle ID mismatch');

    const result = await pool.query('INSERT INTO apps (appid, details) VALUES ($1, $2) ON CONFLICT (appid) DO NOTHING', [appId, details]);
    return result;
}

const popularityExpression = `
    CASE
        WHEN details->>'reviews' ~ '^[0-9]+$' THEN (details->>'reviews')::integer
        ELSE 0
    END`;

const currentAnalysisVersion = parseInt(process.env.CURRENT_ANALYSIS_VERSION || process.env.ANALYSIS_VERSION || '4', 10);
const staleAnalysisDays = parseInt(process.env.STALE_ANALYSIS_DAYS || '180', 10);
const processingTimeoutMinutes = parseInt(process.env.PROCESSING_TIMEOUT_MINUTES || '120', 10);

const nextApp = async () => {
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
            WHERE appid ~ $4
                AND appid !~ '[.]$'
                AND length(appid) <= $5
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
            MAX_APP_ID_LENGTH
        ]);

        if (candidate.rowCount === 0) {
            await client.query('COMMIT');
            return null;
        }

        const result = await client.query(`
            UPDATE apps
            SET status = 'processing',
                processing_started = NOW()
            WHERE appid = $1
            RETURNING appid
        `, [candidate.rows[0].appid]);

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

const updateAnalysis = async (appId, analysis, analysisVersion) => {
    if (!isValidAppId(appId)) throw new TypeError('Invalid App Store bundle ID');

    const { status, failureReason, failureRetryable } = deriveAnalysisState(analysis);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Keep writing the raw payload to apps.analysis (the website failure
        // display and existing HTTP responses depend on it) AND set the new
        // scheduling columns. processing_started is cleared now that the lock
        // is resolved.
        const result = await client.query(
            `UPDATE apps
             SET analysis = $1,
                 analysisVersion = $2,
                 analysed = NOW(),
                 status = $4,
                 failure_reason = $5,
                 failure_retryable = $6,
                 processing_started = NULL
             WHERE appid = $3
             RETURNING appid, details, analysed`,
            [analysis, analysisVersion, appId, status, failureReason, failureRetryable]
        );

        if (result.rowCount > 0) {
            const app = result.rows[0];
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
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    NULLIF($6, '')::timestamp,
                    $7,
                    $8
                )
                ON CONFLICT (appid, analysed) DO NOTHING
            `, [
                appId,
                analysis,
                analysisVersion,
                app.analysed,
                app.details ? app.details.version : null,
                app.details ? app.details.updated : null,
                analysis && analysis.analysis_source ? analysis.analysis_source : 'legacy',
                !(analysis && analysis.success === false)
            ]);
        }

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
    countQueue,
    countAnalysed,
    addApp,
    nextApp,
    updateAnalysis,
    getAllApps,
    getSiteDataSignature,
    healthCheck,
    deriveAnalysisState
}
