'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set before the cache and server modules are loaded.
process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-edge-cache-'));
process.env.UPLOAD_PASSWORD = 'test-secret';
process.env.SITE_URL = 'https://example.test';
process.env.CLOUDFLARE_API_TOKEN = 'purge-token';
process.env.CLOUDFLARE_ZONE_ID = 'zone-id';
process.env.CLOUDFLARE_API_BASE = 'https://api.cloudflare.test/client/v4';

const Apps = require('../models/Apps');
const app = require('../server');

const CLAIM_TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const analysed = new Date('2025-01-02T03:04:05.000Z');
const corpus = [{
  appid: 'com.example.app',
  analysed,
  details: {
    appId: 'com.example.app',
    title: 'Example App',
    icon: 'https://icons.test/app.png',
    version: '1.0',
    url: 'https://apps.apple.com/app',
    reviews: 10,
    primaryGenre: 'News',
    free: true
  },
  analysis: { trackers: { 'Google Firebase Analytics': {} } }
}];

async function withServer(run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

function stubDatabase(t) {
  const original = {
    getSiteDataSignature: Apps.getSiteDataSignature,
    getAllApps: Apps.getAllApps,
    findApp: Apps.findApp,
    updateAnalysis: Apps.updateAnalysis,
    log: console.log
  };

  Apps.getSiteDataSignature = async () => ({
    appCount: corpus.length,
    latestAnalysis: analysed.toISOString()
  });
  Apps.getAllApps = async () => corpus;
  Apps.findApp = async (appId) =>
    corpus.find((row) => row.appid.toLowerCase() === String(appId).toLowerCase()) || null;
  Apps.updateAnalysis = async () => ({ rowCount: 1 });
  console.log = () => {};

  t.after(() => {
    Apps.getSiteDataSignature = original.getSiteDataSignature;
    Apps.getAllApps = original.getAllApps;
    Apps.findApp = original.findApp;
    Apps.updateAnalysis = original.updateAnalysis;
    console.log = original.log;
  });
}

// The purge runs inside the request the test itself makes, so only calls to
// the Cloudflare API are intercepted; everything else reaches the test server.
function stubPurgeApi(t) {
  const purges = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(process.env.CLOUDFLARE_API_BASE))
      return originalFetch(url, init);

    purges.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };

  t.after(() => { globalThis.fetch = originalFetch; });
  return purges;
}

test('published pages are cacheable at the edge and the rest is not', async (t) => {
  stubDatabase(t);

  await withServer(async (base) => {
    const cacheable = ['/', '/statistics', '/about', '/trackers', '/companies',
      '/tracker/google-firebase-analytics', '/analysis/com.example.app',
      '/sitemap.xml', '/robots.txt'];

    for (const page of cacheable) {
      const response = await fetch(`${base}${page}`);
      assert.equal(response.status, 200, page);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=0, s-maxage=300', page);
    }

    // A search result, an analyser response and an error page must not be
    // served to the next visitor from the edge.
    const analyser = { authorization: 'Bearer test-secret' };
    const uncacheable = [
      ['/search?search=', 200, {}],
      ['/request/com.example.missing', 200, {}],
      // Ordered: the ping marks the analyser online, so the health check that
      // reports it offline has to run first.
      ['/healthz/analyser', 503, analyser],
      ['/ping', 200, analyser],
      ['/no-such-page', 404, {}]
    ];

    for (const [page, status, headers] of uncacheable) {
      const response = await fetch(`${base}${page}`, { headers });
      assert.equal(response.status, status, page);
      assert.equal(response.headers.get('cache-control'), 'no-store', page);
    }

    const asset = await fetch(`${base}${app.locals.assetPrefix}/css/styles.css`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /immutable/);
  });
});

test('an uploaded analysis purges the pages it changed', async (t) => {
  stubDatabase(t);
  const purges = stubPurgeApi(t);

  await withServer(async (base) => {
    const upload = await fetch(`${base}/uploadAnalysis?appId=com.example.app&analysisVersion=4`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
        'x-analysis-claim-token': CLAIM_TOKEN
      },
      body: JSON.stringify({ success: true, trackers: {} })
    });

    assert.equal(upload.status, 200);
    assert.equal(purges.length, 1);
    assert.equal(purges[0].url, 'https://api.cloudflare.test/client/v4/zones/zone-id/purge_cache');
    assert.deepEqual(purges[0].body.files, [
      'https://example.test/analysis/com.example.app',
      'https://example.test/',
      'https://example.test/statistics',
      'https://example.test/trackers',
      'https://example.test/companies',
      'https://example.test/sitemap.xml'
    ]);
  });
});

test('a failed analysis purges the report that showed the app as queued', async (t) => {
  stubDatabase(t);
  const purges = stubPurgeApi(t);

  await withServer(async (base) => {
    const report = await fetch(`${base}/reportAnalysisFailure?appId=com.example.app&analysisVersion=4`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'text/plain',
        'x-analysis-claim-token': CLAIM_TOKEN
      },
      body: 'analysis failed'
    });

    assert.equal(report.status, 200);
    assert.equal(purges.length, 1);
    assert.ok(purges[0].body.files.includes('https://example.test/analysis/com.example.app'));
  });
});
