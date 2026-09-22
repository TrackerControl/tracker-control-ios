'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set before the cache and server modules are loaded.
process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-purge-cache-'));
process.env.UPLOAD_PASSWORD = 'test-secret';
process.env.SITE_URL = 'https://example.test';
process.env.CLOUDFLARE_API_TOKEN = 'purge-token';
process.env.CLOUDFLARE_ZONE_ID = 'zone-id';
process.env.CLOUDFLARE_API_BASE = 'https://api.cloudflare.test/client/v4';

const Apps = require('../models/Apps');
const app = require('../server');

const CLAIM_TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function stubAnalysisUpdate(t) {
  const original = { updateAnalysis: Apps.updateAnalysis, log: console.log };
  Apps.updateAnalysis = async () => ({ rowCount: 1 });
  console.log = () => {};

  t.after(() => {
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

test('an uploaded analysis purges the pages it changed', async (t) => {
  stubAnalysisUpdate(t);
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
  });
});

test('a failed analysis purges the report that showed the app as queued', async (t) => {
  stubAnalysisUpdate(t);
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
