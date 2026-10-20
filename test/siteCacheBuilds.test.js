'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set before the cache and server modules are loaded: the cache
// directory is resolved at require time.
process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cache-'));
process.env.UPLOAD_PASSWORD = 'test-secret';
process.env.SITE_URL = 'https://example.test';

const Apps = require('../models/Apps');
const app = require('../server');

const analysed = new Date('2025-01-02T03:04:05.000Z');
const corpus = [
  {
    appid: 'com.example.one',
    analysed,
    details: { title: 'Example One', icon: 'https://icons.test/one.png', reviews: 500, primaryGenre: 'Games' },
    analysis: { success: true, trackers: { 'Google Firebase Analytics': {} } }
  }
];

test('concurrent requests after a change share one rebuild of each cached view', async () => {
  const original = {
    getSiteDataSignature: Apps.getSiteDataSignature,
    getAllApps: Apps.getAllApps,
    log: console.log
  };
  let generation = 1;
  let loads = 0;
  const rebuilt = [];
  Apps.getSiteDataSignature = async () => ({
    appCount: corpus.length,
    latestAnalysis: analysed.toISOString(),
    latestStorefront: `generation-${generation}`
  });
  Apps.getAllApps = async () => {
    loads++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return corpus;
  };
  console.log = (...args) => {
    if (String(args[0]).includes('rebuilt')) rebuilt.push(args[0]);
  };

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const burst = () => Promise.all(['/', '/', '/statistics', '/trackers', '/trackers', '/companies']
    .map(async (p) => {
      const response = await fetch(base + p);
      assert.equal(response.status, 200, p);
      await response.text();
    }));

  try {
    await burst();
    assert.equal(loads, 1);
    assert.deepEqual(rebuilt.sort(), ['Reverse index rebuilt for', 'Site data cache rebuilt for']);

    // Unchanged data is served from memory without touching the database.
    await burst();
    assert.equal(loads, 1);

    // The signature memo lasts five seconds, so wait it out before the next
    // generation of data.
    generation = 2;
    rebuilt.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await burst();
    assert.equal(loads, 2);
    assert.equal(rebuilt.length, 2);
  } finally {
    Apps.getSiteDataSignature = original.getSiteDataSignature;
    Apps.getAllApps = original.getAllApps;
    console.log = original.log;
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
});
