const assert = require('node:assert/strict');
const test = require('node:test');
const {
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
