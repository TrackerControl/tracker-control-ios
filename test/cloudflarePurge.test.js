'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cloudflare = require('../lib/cloudflarePurge');

const configured = {
  token: 'purge-token',
  zoneId: 'zone-id',
  apiBase: 'https://api.test/client/v4'
};

function recordingFetch(response = { ok: true, body: { success: true } }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: response.ok,
      status: response.status || (response.ok ? 200 : 500),
      json: async () => response.body
    };
  };

  return { calls, fetchImpl };
}

test('the integration is inert until both credentials are set', () => {
  assert.equal(cloudflare.getPurgeConfiguration({ token: 'only-token', zoneId: '  ' }), null);
  assert.equal(cloudflare.getPurgeConfiguration({ token: '', zoneId: 'zone' }), null);
  assert.equal(cloudflare.isConfigured({ token: ' t ', zoneId: ' z ' }), true);
  assert.equal(
    cloudflare.getPurgeConfiguration({ token: 't', zoneId: 'z', apiBase: '' }).apiBase,
    cloudflare.DEFAULT_API_BASE
  );
});

test('an unconfigured purge makes no request', async () => {
  const { calls, fetchImpl } = recordingFetch();

  const purged = await cloudflare.purgeUrls(['https://example.test/'], {
    token: '', zoneId: '', fetch: fetchImpl
  });

  assert.equal(purged, false);
  assert.equal(calls.length, 0);
});

test('a new analysis purges its report and the pages built from it', () => {
  assert.deepEqual(cloudflare.analysisUrls('https://example.test/', 'com.example.app'), [
    'https://example.test/analysis/com.example.app',
    'https://example.test/da/analysis/com.example.app',
    'https://example.test/',
    'https://example.test/da/',
    'https://example.test/statistics',
    'https://example.test/da/statistics',
    'https://example.test/trackers',
    'https://example.test/da/trackers',
    'https://example.test/companies',
    'https://example.test/da/companies',
    'https://example.test/sitemap.xml'
  ]);
  assert.deepEqual(cloudflare.analysisUrls('', 'com.example.app'), []);
});

test('the purge call carries the token and the URLs', async () => {
  const { calls, fetchImpl } = recordingFetch();

  const purged = await cloudflare.purgeAfterAnalysis('https://example.test', 'com.example.app', {
    ...configured, fetch: fetchImpl
  });

  assert.equal(purged, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/client/v4/zones/zone-id/purge_cache');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer purge-token');
  assert.deepEqual(calls[0].body.files, cloudflare.analysisUrls('https://example.test', 'com.example.app'));
});

test('duplicate URLs collapse and long lists are split across calls', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const urls = [];
  for (let i = 0; i < cloudflare.MAX_URLS_PER_REQUEST + 5; i++)
    urls.push(`https://example.test/analysis/com.example.${i}`);

  await cloudflare.purgeUrls([...urls, urls[0]], { ...configured, fetch: fetchImpl });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.files.length, cloudflare.MAX_URLS_PER_REQUEST);
  assert.equal(calls[1].body.files.length, 5);
});

test('a refused purge is reported, not thrown', async (t) => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = originalError; });

  const rejected = recordingFetch({ ok: true, body: { success: false, errors: [{ message: 'Invalid zone' }] } });
  assert.equal(await cloudflare.purgeUrls(['https://example.test/'], { ...configured, fetch: rejected.fetchImpl }), false);

  const unauthorized = recordingFetch({ ok: false, status: 403, body: {} });
  assert.equal(await cloudflare.purgeUrls(['https://example.test/'], { ...configured, fetch: unauthorized.fetchImpl }), false);

  const offline = async () => { throw new Error('network down'); };
  assert.equal(await cloudflare.purgeUrls(['https://example.test/'], { ...configured, fetch: offline }), false);

  assert.equal(errors.length, 3);
  assert.match(errors[0], /Invalid zone/);
  assert.match(errors[1], /403/);
  assert.match(errors[2], /network down/);
});
