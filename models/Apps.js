const { Pool } = require('pg');
const pool = new Pool();

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
                ORDER BY added ASC 
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
    const result = await pool.query('UPDATE apps SET analysis = $1, analysisVersion = $2, analysed = NOW() WHERE appid = $3', [analysis, analysisVersion, appId]);
    return result;
}

const getAllApps = async () => {
    const result = await pool.query('SELECT * FROM apps WHERE analysis IS NOT NULL');
    return result.rows;
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
    addApp,
    nextApp,
    updateAnalysis,
    getAllApps,
    resetLongProcessingJobs
}
