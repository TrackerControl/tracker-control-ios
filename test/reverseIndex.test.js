'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const reverseIndex = require('../lib/reverseIndex');

function app(appid, { trackers, title, reviews, analysed, success, genre } = {}) {
  return {
    appid,
    analysed: analysed || '2025-01-01T00:00:00.000Z',
    details: {
      appId: appid,
      title: title || appid,
      icon: `https://example.test/${appid}.png`,
      reviews: reviews === undefined ? 0 : reviews,
      primaryGenre: genre || 'Utilities'
    },
    analysis: success === false
      ? { success: false, reason: 'app_not_found' }
      : { trackers: (trackers || []).reduce((acc, name) => ({ ...acc, [name]: {} }), {}) }
  };
}

const corpus = [
  app('com.example.one', { trackers: ['Google Firebase Analytics', 'Facebook Login'], reviews: 500, title: 'One' }),
  app('com.example.two', { trackers: ['Google Firebase Analytics'], reviews: 9000, title: 'Two' }),
  app('com.example.three', { trackers: [], reviews: 10, title: 'Three' }),
  app('com.example.four', { trackers: ['Google Firebase Analytics'], success: false, title: 'Four' })
];

test('index counts apps per tracker and uses all analysed apps as denominator', () => {
  const index = reverseIndex.buildReverseIndex(corpus);

  // The failed analysis is excluded; the tracker-free app still counts.
  assert.equal(index.totalApps, 3);
  assert.equal(index.trackedApps, 2);

  const slug = index.trackerSlugs['google firebase analytics'];
  const firebase = reverseIndex.lookupTracker(index, slug);
  assert.equal(firebase.appCount, 2);
  assert.equal(firebase.pct, '66.7');
  assert.ok(!firebase.appIds.includes('com.example.four'));
});

test('apps within a tracker are ordered by review count', () => {
  const index = reverseIndex.buildReverseIndex(corpus);
  const firebase = reverseIndex.lookupTracker(index, index.trackerSlugs['google firebase analytics']);

  assert.deepEqual(firebase.appIds, ['com.example.two', 'com.example.one']);
});

test('the app directory covers analysed apps without trackers', () => {
  const index = reverseIndex.buildReverseIndex(corpus);

  assert.ok(index.apps['com.example.three']);
  assert.equal(index.apps['com.example.three'].trackerCount, 0);
  assert.equal(index.apps['com.example.three'].classification, 'no_tracking');
  assert.ok(!index.apps['com.example.four'], 'failed analyses stay out of the directory');
});

test('trackers are grouped under the company that owns them', () => {
  const index = reverseIndex.buildReverseIndex(corpus);
  const firebase = reverseIndex.lookupTracker(index, index.trackerSlugs['google firebase analytics']);

  assert.equal(firebase.company, 'Alphabet');
  assert.equal(firebase.region, 'US');

  const company = reverseIndex.lookupCompany(index, firebase.companySlug);
  assert.equal(company.name, 'Alphabet');
  assert.equal(company.appCount, 2);
  assert.ok(company.trackers.some((tracker) => tracker.name === 'Google Firebase Analytics'));
});

test('an app is counted once per company even with several of its trackers', () => {
  const index = reverseIndex.buildReverseIndex([
    app('com.example.multi', { trackers: ['Google Firebase Analytics', 'Google AdMob'], reviews: 1 })
  ]);

  const firebase = reverseIndex.lookupTracker(index, index.trackerSlugs['google firebase analytics']);
  const company = reverseIndex.lookupCompany(index, firebase.companySlug);

  assert.equal(company.appCount, 1);
  assert.equal(company.trackers.length, 2);
});

test('system APIs are flagged rather than listed as unattributed trackers', () => {
  const index = reverseIndex.buildReverseIndex([
    app('com.example.system', { trackers: ['AdID access'], reviews: 1 })
  ]);

  const entry = reverseIndex.lookupTracker(index, index.trackerSlugs['adid access']);
  assert.equal(entry.system, true);
  assert.equal(entry.company, null);
  assert.equal(entry.region, 'Unresolved');
});

test('slugs are URL-safe and collisions get distinct slugs', () => {
  assert.equal(reverseIndex.slugify('Mob.com'), 'mob-com');
  assert.equal(reverseIndex.slugify('Unity3d Ads'), 'unity3d-ads');
  assert.equal(reverseIndex.slugify('!!!'), 'unnamed');

  const index = reverseIndex.buildReverseIndex([
    app('com.example.collide', { trackers: ['Mob.com', 'Mob com'], reviews: 1 })
  ]);

  const slugs = index.trackerList.slice().sort();
  assert.deepEqual(slugs, ['mob-com', 'mob-com-2']);
  for (const slug of slugs) assert.ok(reverseIndex.lookupTracker(index, slug));
});

test('lookup rejects invalid slugs and inherited properties', () => {
  const index = reverseIndex.buildReverseIndex(corpus);

  assert.equal(reverseIndex.lookupTracker(index, 'constructor'), null);
  assert.equal(reverseIndex.lookupTracker(index, '__proto__'), null);
  assert.equal(reverseIndex.lookupTracker(index, '../../etc/passwd'), null);
  assert.equal(reverseIndex.lookupTracker(index, ''), null);
  assert.equal(reverseIndex.isValidSlug('Mob-Com'), false);
  assert.equal(reverseIndex.isValidSlug('mob-com'), true);
});

test('the index survives a JSON cache round-trip', () => {
  const index = JSON.parse(JSON.stringify(reverseIndex.buildReverseIndex(corpus)));
  const firebase = reverseIndex.lookupTracker(index, index.trackerSlugs['google firebase analytics']);

  assert.equal(firebase.appCount, 2);
  assert.equal(index.trackerList[0], firebase.slug);
});

test('pagination clamps the page number and resolves app records', () => {
  const index = reverseIndex.buildReverseIndex(corpus);
  const firebase = reverseIndex.lookupTracker(index, index.trackerSlugs['google firebase analytics']);

  const first = reverseIndex.paginate(firebase.appIds, index.apps, 1, 1);
  assert.equal(first.totalPages, 2);
  assert.equal(first.from, 1);
  assert.equal(first.to, 1);
  assert.equal(first.apps[0].title, 'Two');

  const clamped = reverseIndex.paginate(firebase.appIds, index.apps, 99, 1);
  assert.equal(clamped.page, 2);
  assert.equal(clamped.apps[0].title, 'One');

  const empty = reverseIndex.paginate([], index.apps, 1, 50);
  assert.equal(empty.total, 0);
  assert.equal(empty.from, 0);
  assert.equal(empty.apps.length, 0);
});

test('parsePage falls back to the first page for junk input', () => {
  assert.equal(reverseIndex.parsePage('3'), 3);
  assert.equal(reverseIndex.parsePage('0'), 1);
  assert.equal(reverseIndex.parsePage('-2'), 1);
  assert.equal(reverseIndex.parsePage('abc'), 1);
  assert.equal(reverseIndex.parsePage(undefined), 1);
});

test('slugForName only resolves names that are present', () => {
  const index = reverseIndex.buildReverseIndex(corpus);

  assert.equal(
    reverseIndex.slugForName(index.trackerSlugs, 'GOOGLE FIREBASE ANALYTICS'),
    index.trackerSlugs['google firebase analytics']
  );
  assert.equal(reverseIndex.slugForName(index.trackerSlugs, 'Not A Tracker'), null);
  assert.equal(reverseIndex.slugForName(index.trackerSlugs, 'toString'), null);
  assert.equal(reverseIndex.slugForName(index.trackerSlugs, null), null);
});
