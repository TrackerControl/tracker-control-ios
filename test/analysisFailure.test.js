const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyAnalysisFailure } = require('../lib/analysisFailure');

test('marks minimum-iOS failures as non-retryable', () => {
  assert.deepEqual(
    classifyAnalysisFailure('Install failed: DeviceOSVersionTooLow. Have 16.7.11; need 17.0'),
    { reason: 'ios_version_too_low', retryable: false }
  );
});

test('keeps unknown analysis failures retryable', () => {
  assert.deepEqual(
    classifyAnalysisFailure('trackerscan exited unexpectedly'),
    { reason: 'analysis_failed', retryable: true }
  );
});

test('marks apps that became paid as non-retryable', () => {
  assert.deepEqual(
    classifyAnalysisFailure('ipatool: purchasing paid apps is not supported'),
    { reason: 'paid_app', retryable: false }
  );
});
