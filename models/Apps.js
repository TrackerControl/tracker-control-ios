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

const nextApp = async () => {
    const processingIndicator = {
        success: false, 
        logs: 'Processing in progress', 
        timestamp: new Date().toISOString() // ISO 8601 format
    };

    try {
        await pool.query('BEGIN');

        const result = await pool.query(`
            UPDATE apps
            SET analysis = $1
            WHERE appid = (
                SELECT appid
                FROM apps
                WHERE analysis IS NULL
                ORDER BY ${popularityExpression} DESC, added ASC
                LIMIT 1
            )
            RETURNING appid;`, [JSON.stringify(processingIndicator)]);

        await pool.query('COMMIT');

        if (result.rowCount === 0) {
            return null;
        }

        console.log('Processing started for app:', result.rows[0].appid);
        return result.rows[0];
    } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
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

        const historyTable = await client.query("SELECT to_regclass('public.app_analyses') AS table_name");
        if (result.rowCount > 0 && historyTable.rows[0].table_name) {
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
