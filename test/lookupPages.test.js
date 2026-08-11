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
    appid: 'com.example.two',
    analysed,
    details: {
      appId: 'com.example.two',
      title: 'Example Two',
      icon: 'https://icons.test/two.png',
      version: '2.0',
      url: 'https://apps.apple.com/two',
      reviews: 9000,
      primaryGenre: 'News',
      free: true
    },
    analysis: { trackers: { 'Google Firebase Analytics': {} }, permissions: ['Camera'] }
  },
  {
    appid: 'com.example.one',
    analysed,
    details: {
      appId: 'com.example.one',
      title: 'Example One',
      icon: 'https://icons.test/one.png',
      version: '1.0',
      url: 'https://apps.apple.com/one',
      reviews: 500,
      primaryGenre: 'Games',
      free: true
    },
    // The queue-time snapshot above is frozen; this is what the metadata
    // refresh job keeps up to date.
    current_storefront_details: {
      title: 'Example One Renamed',
      icon: 'https://icons.test/one-v2.png'
    },
    analysis: { trackers: { 'Google Firebase Analytics': {}, 'Facebook Login': {} } }
  }
];

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

function stubDatabase() {
  const original = {
    getSiteDataSignature: Apps.getSiteDataSignature,
    getAllApps: Apps.getAllApps,
    findApp: Apps.findApp,
    log: console.log
  };

  Apps.getSiteDataSignature = async () => ({
    appCount: corpus.length,
    latestAnalysis: analysed.toISOString()
  });
  Apps.getAllApps = async () => corpus;
  Apps.findApp = async (appId) =>
    corpus.find((row) => row.appid.toLowerCase() === String(appId).toLowerCase()) || null;
  console.log = () => {};

  return () => {
    Apps.getSiteDataSignature = original.getSiteDataSignature;
    Apps.getAllApps = original.getAllApps;
    Apps.findApp = original.findApp;
    console.log = original.log;
  };
}

test('reverse lookup, methodology, sitemap and social metadata', async (t) => {
  const restore = stubDatabase();

  try {
    await withServer(async (base) => {
      await t.test('tracker directory lists trackers and links to lookups', async () => {
        const response = await fetch(`${base}/trackers`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /Google Firebase Analytics/);
        assert.match(body, /href="\/tracker\/google-firebase-analytics"/);
        assert.match(body, /href="\/company\/alphabet"/);
      });

      await t.test('company directory renders', async () => {
        const response = await fetch(`${base}/companies`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /href="\/company\/alphabet"/);
      });

      await t.test('tracker page lists the apps, most reviewed first', async () => {
        const response = await fetch(`${base}/tracker/google-firebase-analytics`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /href="\/analysis\/com.example.two"/);
        assert.match(body, /href="\/analysis\/com.example.one"/);
        assert.ok(
          body.indexOf('Example Two') < body.indexOf('Example One'),
          'the app with more reviews should come first'
        );
        assert.match(body, /<meta property="og:url" content="https:\/\/example.test\/tracker\/google-firebase-analytics">/);
        assert.match(body, /detected in 2 of 2 analysed iOS apps/);
      });

      await t.test('listing pages show refreshed storefront metadata, not the queue snapshot', async () => {
        const response = await fetch(`${base}/tracker/google-firebase-analytics`);
        const body = await response.text();

        assert.match(body, /Example One Renamed/);
        assert.match(body, /one-v2\.png/);
        assert.doesNotMatch(body, /icons\.test\/one\.png/);
      });

      await t.test('company page aggregates its trackers', async () => {
        const response = await fetch(`${base}/company/alphabet`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /href="\/tracker\/google-firebase-analytics"/);
        assert.match(body, /href="\/analysis\/com.example.two"/);
      });

      await t.test('unknown slugs 404 instead of erroring', async () => {
        for (const url of ['/tracker/no-such-tracker', '/company/no-such-company', '/tracker/__proto__']) {
          const response = await fetch(`${base}${url}`);
          assert.equal(response.status, 404, url);
        }
      });

      await t.test('methodology page renders with sampling caveats', async () => {
        const response = await fetch(`${base}/methodology`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /This is not a random sample of the App Store/);
        assert.match(body, /<link rel="canonical" href="https:\/\/example.test\/methodology">/);
      });

      await t.test('app report links trackers to their lookup page and sets a social image', async () => {
        const response = await fetch(`${base}/analysis/com.example.one`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /href="\/tracker\/google-firebase-analytics"/);
        // The social card follows the same storefront precedence as the report
        // body, so it cannot advertise a title or icon the page contradicts.
        assert.match(body, /<meta property="og:image" content="https:\/\/icons\.test\/one-v2\.png">/);
        assert.match(body, /2 trackers were detected in Example One Renamed/);
      });

      await t.test('statistics page links its tables into the lookup pages', async () => {
        const response = await fetch(`${base}/statistics`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /href="\/tracker\/google-firebase-analytics"/);
        assert.match(body, /href="\/company\/alphabet"/);
      });

      await t.test('sitemap covers reports, lookups and reference pages', async () => {
        const response = await fetch(`${base}/sitemap.xml`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /xml/);
        assert.match(body, /<loc>https:\/\/example.test\/<\/loc>/);
        assert.match(body, /<loc>https:\/\/example.test\/methodology<\/loc>/);
        assert.match(body, /<loc>https:\/\/example.test\/tracker\/google-firebase-analytics<\/loc>/);
        assert.match(body, /<loc>https:\/\/example.test\/company\/alphabet<\/loc>/);
        assert.match(body, /<loc>https:\/\/example.test\/analysis\/com.example.one<\/loc>/);
        assert.match(body, new RegExp(`<lastmod>${analysed.toISOString()}</lastmod>`));
      });

      await t.test('robots.txt points at the sitemap', async () => {
        const response = await fetch(`${base}/robots.txt`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /Sitemap: https:\/\/example.test\/sitemap.xml/);
      });
    });
  } finally {
    restore();
    fs.rmSync(process.env.CACHE_DIR, { recursive: true, force: true });
  }
});
