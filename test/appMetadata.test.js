'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildReportMetadata } = require('../lib/appMetadata');

test('report metadata prefers current storefront and exposes version divergence', () => {
  const metadata = buildReportMetadata({
    analysis: {
      analysis_app_version: '1.0',
      analysed: new Date('2026-08-01T12:00:00Z'),
      version: '9.9'
    },
    queueSnapshot: {
      title: 'Queue title',
      icon: 'queue-icon',
      url: 'queue-url',
      version: '1.0'
    },
    storefront: {
      details: {
        title: 'Current title',
        icon: 'current-icon',
        url: 'current-url',
        version: '1.2'
      },
      fetched_at: new Date('2026-08-10T12:00:00Z')
    }
  });

  assert.equal(metadata.title, 'Current title');
  assert.equal(metadata.icon, 'current-icon');
  assert.equal(metadata.url, 'current-url');
  assert.equal(metadata.analysedVersion, '1.0');
  assert.equal(metadata.currentVersion, '1.2');
  assert.equal(metadata.analysedAt.toISOString(), '2026-08-01T12:00:00.000Z');
  assert.equal(metadata.currentFetchedAt.toISOString(), '2026-08-10T12:00:00.000Z');
});

test('queued metadata has no analysed-version label and falls back to queue snapshot', () => {
  const metadata = buildReportMetadata({
    analysis: null,
    queueSnapshot: { title: 'Queued', icon: 'queue-icon', url: 'queue-url', version: '1.0' },
    storefront: { details: { version: '1.1' }, fetched_at: new Date() }
  });

  assert.equal(metadata.title, 'Queued');
  assert.equal(metadata.icon, 'queue-icon');
  assert.equal(metadata.url, 'queue-url');
  assert.equal(metadata.analysedVersion, null);
  assert.equal(metadata.currentVersion, null);
});

test('matching current storefront versions are not repeated as a second label', () => {
  const metadata = buildReportMetadata({
    analysis: { analysis_app_version: '1.0' },
    queueSnapshot: { title: 'Queue', version: '1.0' },
    storefront: { details: { title: 'Store', version: '1.0' } }
  });

  assert.equal(metadata.analysedVersion, '1.0');
  assert.equal(metadata.currentVersion, null);
});
