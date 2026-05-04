const { Pool } = require('pg');
const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {}
);

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
});

const lastAnalysed = async () => {
    const result = await pool.query('SELECT * FROM apps WHERE analysis IS NOT NULL ORDER BY analysed DESC LIMIT 5');
    return result.rows;
}

const findApp = async (appId) => {
    const result = await pool.query('SELECT * FROM apps WHERE appid = $1', [appId]);
    if (result.rows.length == 0)
        return null;

    return result.rows[0];
}

const countQueue = async (added) => {
    if (added) {
        const result = await pool.query('SELECT COUNT(*) FROM apps WHERE analysis IS NULL AND added < $1', [added]);
        return result.rows[0].count;
    } else {
        const result = await pool.query('SELECT COUNT(*) FROM apps WHERE analysis IS NULL');
        return result.rows[0].count;
    }
}

const addApp = async (appId, details) => {
    const result = await pool.query('INSERT INTO apps (appid, details) VALUES ($1, $2)', [appId, details]);
    return result;
}

const popularityExpression = `
    CASE
        WHEN details->>'reviews' ~ '^[0-9]+$' THEN (details->>'reviews')::integer
        ELSE 0
    END`;

const currentAnalysisVersion = parseInt(process.env.CURRENT_ANALYSIS_VERSION || process.env.ANALYSIS_VERSION || '3', 10);
const staleAnalysisDays = parseInt(process.env.STALE_ANALYSIS_DAYS || '180', 10);

async function historyTableExists(client) {
    const result = await client.query("SELECT to_regclass('public.app_analyses') AS table_name");
    return Boolean(result.rows[0].table_name);
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

const nextApp = async () => {
    const processingIndicator = {
        success: false,
        logs: 'Processing in progress',
        timestamp: new Date().toISOString() // ISO 8601 format
    };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const candidate = await client.query(`
            SELECT appid, analysis
            FROM apps
            WHERE analysis IS NULL
                OR (
                    coalesce(analysis->>'logs', '') <> 'Processing in progress'
                    AND (
                        analysisversion IS DISTINCT FROM $1
                        OR analysed < NOW() - ($2::int * INTERVAL '1 day')
                    )
                )
            ORDER BY ${popularityExpression} DESC, added ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `, [currentAnalysisVersion, staleAnalysisDays]);

        if (candidate.rowCount === 0) {
            await client.query('COMMIT');
            return null;
        }

        const app = candidate.rows[0];
        if (app.analysis && await historyTableExists(client)) {
            await snapshotCurrentAnalysis(client, app.appid);
        }

        const result = await client.query(`
            UPDATE apps
            SET analysis = $1
            WHERE appid = $2
            RETURNING appid
        `, [JSON.stringify(processingIndicator), app.appid]);

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
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const result = await client.query(
            'UPDATE apps SET analysis = $1, analysisVersion = $2, analysed = NOW() WHERE appid = $3 RETURNING appid, details, analysed',
            [analysis, analysisVersion, appId]
        );

        if (result.rowCount > 0 && await historyTableExists(client)) {
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
                SELECT
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    NULLIF($6, '')::timestamp,
                    $7,
                    $8
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
    const result = await pool.query('SELECT * FROM apps WHERE analysis IS NOT NULL');
    return result.rows;
}

const getSiteDataSignature = async () => {
    const result = await pool.query(`
        SELECT
            COUNT(*) FILTER (
                WHERE analysis IS NOT NULL
                    AND COALESCE(analysis->>'success', 'true') != 'false'
                    AND analysis->'trackers' IS NOT NULL
            ) AS app_count,
            MAX(analysed) FILTER (
                WHERE analysis IS NOT NULL
                    AND COALESCE(analysis->>'success', 'true') != 'false'
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
    const result = await pool.query("SELECT COUNT(*) FROM apps WHERE analysis IS NOT NULL AND analysis ->> 'success' != 'false'");
    return parseInt(result.rows[0].count, 10);
}

// TODO: cron method; not regularly called yet
const resetLongProcessingJobs = async () => {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    try {
        const result = await pool.query(`
            UPDATE apps 
            SET analysis = NULL
            WHERE analysis ->> 'success' = 'false' 
              AND (analysis ->> 'timestamp')::timestamp < $1`, [oneMonthAgo.toISOString()]);

        console.log(`${result.rowCount} apps reset that were processing for more than a month.`);
    } catch (err) {
        console.error('Error resetting long-processing jobs:', err);
    }
};

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
    resetLongProcessingJobs
}
