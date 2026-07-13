const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveAnalysisState } = require('../models/Apps');

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
