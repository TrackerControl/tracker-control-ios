const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAnalysisProvenanceSourceSql,
  canonicalAppId,
  deriveAnalysisState,
  updateAnalysisWithClient
} = require('../models/Apps');

const ACTIVE_TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STALE_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function claimedAppClient(activeToken = ACTIVE_TOKEN) {
  const state = {
    appid: 'com.example.App',
    status: 'processing',
    analysisClaimToken: activeToken,
    analysis: null,
    history: []
  };

  return {
    state,
    async query(sql, params) {
      if (/UPDATE apps/.test(sql)) {
        assert.match(sql, /AND status = 'processing'/);
        assert.match(sql, /AND analysis_claim_token = \$7/);
        assert.match(sql, /analysis_claim_token = NULL/);
        const matches = state.status === 'processing' && state.analysisClaimToken === params[6];
        if (!matches) return { rowCount: 0, rows: [] };

        state.analysis = params[0];
        state.status = params[3];
        state.analysisClaimToken = null;
        return {
          rowCount: 1,
          rows: [{
            appid: state.appid,
            details: { version: '1.0', updated: '2026-01-01T00:00:00Z' },
            analysed: new Date('2026-01-02T00:00:00Z')
          }]
        };
      }

      if (/INSERT INTO app_analyses/.test(sql)) {
        state.history.push(params);
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test('successful analysis maps to analysed with no failure fields', () => {
  assert.deepEqual(
    deriveAnalysisState({ success: true, trackers: {} }),
    { status: 'analysed', failureReason: null, failureRetryable: null }
  );
});

test('missing success flag is treated as a successful analysis', () => {
  assert.deepEqual(
    deriveAnalysisState({ trackers: {} }),
    { status: 'analysed', failureReason: null, failureRetryable: null }
  );
});

test('failure keeps reason and defaults retryable to true', () => {
  assert.deepEqual(
    deriveAnalysisState({ success: false, reason: 'analysis_failed', logs: 'boom' }),
    { status: 'failed', failureReason: 'analysis_failed', failureRetryable: true }
  );
});

test('failure with retryable false is non-retryable', () => {
  assert.deepEqual(
    deriveAnalysisState({ success: false, reason: 'paid_app', retryable: false }),
    { status: 'failed', failureReason: 'paid_app', failureRetryable: false }
  );
});

test('failure falls back to logs when reason is absent', () => {
  assert.deepEqual(
    deriveAnalysisState({ success: false, logs: 'raw log text' }),
    { status: 'failed', failureReason: 'raw log text', failureRetryable: true }
  );
});

test('accepts mixed-case requests and uses App Store canonical bundle ID', () => {
  assert.equal(
    canonicalAppId('COM.Example.app', { appId: 'com.example.App' }),
    'com.example.App'
  );
  assert.throws(
    () => canonicalAppId('com.example.app', { appId: 'com.other.app' }),
    /bundle ID mismatch/
  );
});

test('active analysis claim completes and consumes its token', async () => {
  const client = claimedAppClient();
  const result = await updateAnalysisWithClient(
    client,
    'com.example.App',
    { success: true, trackers: {} },
    4,
    ACTIVE_TOKEN
  );

  assert.equal(result.rowCount, 1);
  assert.equal(client.state.status, 'analysed');
  assert.equal(client.state.analysisClaimToken, null);
  assert.equal(client.state.history.length, 1);
});

test('analysis history normalizes empty source and non-boolean success values', async () => {
  const client = claimedAppClient();
  await updateAnalysisWithClient(
    client,
    'com.example.App',
    { success: 'unexpected', analysis_source: '' },
    4,
    ACTIVE_TOKEN
  );

  assert.equal(client.state.history[0][3], 'legacy');
  assert.equal(client.state.history[0][4], true);
});

test('history insert sources analysed from apps in SQL, not as a bound parameter', async () => {
  const queries = [];
  const state = {
    appid: 'com.example.App',
    status: 'processing',
    analysisClaimToken: ACTIVE_TOKEN
  };
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/UPDATE apps/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ appid: state.appid, details: { version: '1.0' } }]
        };
      }
      if (/INSERT INTO app_analyses/.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  await updateAnalysisWithClient(
    client,
    'com.example.App',
    { success: true, trackers: {} },
    4,
    ACTIVE_TOKEN
  );

  const insert = queries.find(({ sql }) => /INSERT INTO app_analyses/.test(sql));
  assert.ok(insert);
  // analysed must come from the apps row read in the same SQL statement, not
  // from a JS-bound parameter -- otherwise node-postgres' millisecond-precision
  // Date round-trip truncates the microsecond timestamp Postgres stored for
  // apps.analysed and the findApp history join never matches it again.
  assert.match(insert.sql, /SELECT\s+\$1,\s*\$2,\s*\$3,\s*apps\.analysed,/);
  assert.equal(insert.params.length, 5);
  assert.deepEqual(insert.params, [
    'com.example.App',
    { success: true, trackers: {} },
    4,
    'legacy',
    true
  ]);
});

test('stale analysis claim cannot overwrite a newer assignment', async () => {
  const client = claimedAppClient(ACTIVE_TOKEN);
  const result = await updateAnalysisWithClient(
    client,
    'com.example.App',
    { success: false, reason: 'stale result' },
    4,
    STALE_TOKEN
  );

  assert.equal(result.rowCount, 0);
  assert.equal(client.state.status, 'processing');
  assert.equal(client.state.analysisClaimToken, ACTIVE_TOKEN);
  assert.equal(client.state.analysis, null);
  assert.equal(client.state.history.length, 0);
});

test('app_store_updated is cast to timestamptz so the App Store offset survives', () => {
  const provenance = buildAnalysisProvenanceSourceSql();

  // details->>'updated' is currentVersionReleaseDate, an ISO 8601 instant with
  // a Z offset, and the column is timestamptz. A ::timestamp cast would drop
  // the offset and re-anchor the reading in the session time zone, which is
  // only harmless while the server runs UTC.
  assert.match(provenance.select.appStoreUpdated, /::timestamptz$/);
  assert.doesNotMatch(provenance.select.appStoreUpdated, /::timestamp$/);
});
