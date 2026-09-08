'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const pug = require('pug');

const views = path.join(__dirname, '..', 'views');
const labels = {
  no_tracking: { label: 'No known trackers detected' },
  unresolved_only: { label: 'Unresolved trackers' },
  us_only: { label: 'US-only tracking' },
  european_only: { label: 'European-only tracking' },
  mixed_with_us_cn: { label: 'US and Chinese tracking' },
  mixed_with_us: { label: 'US and other tracking' },
  mixed_no_us: { label: 'Mixed tracking without US' }
};

const base = {
  title: 'Test page',
  siteName: 'TrackerControl for iOS',
  pageDescription: 'Test description',
  canonicalUrl: 'https://example.test/',
  currentPath: '/',
  data: {},
  jurisdictionMeta: labels
};

function render(name, locals = {}) {
  return pug.renderFile(path.join(views, name), { ...base, ...locals });
}

function assertSingleH1(html, page) {
  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${page} has one h1`);
}

const jurisdictionData = {
  classification: 'mixed_with_us',
  meta: labels.mixed_with_us,
  resolvedCount: 1,
  unresolvedCount: 0,
  trackerDetails: [{
    name: 'Acme Analytics', company: 'Acme Corp', countryName: 'United States', region: 'US'
  }],
  regionBreakdown: { US: 1 }
};

const reportBase = {
  app: {
    appid: 'com.example.app',
    details: { appId: 'com.example.app', title: 'Example App', version: '1.2.3' },
    reportMetadata: {
      title: 'Example App', analysedVersion: null,
      analysedAt: new Date('2026-09-08T10:00:00Z'), currentVersion: '1.3.0',
      currentVersionFromStorefront: true, currentFetchedAt: new Date('2026-09-08T11:00:00Z')
    },
    analysis: {
      success: true,
      trackers: { 'Acme Analytics': {}, 'Adid Access': {} },
      permissions: ['Camera'],
      trackingDomains: ['analytics.example.test']
    }
  },
  trackerCount: 1,
  systemTrackerNames: ['Adid Access'],
  trackerNameToExodus: { 'Acme Analytics': { id: 12, categories: ['Analytics'] } },
  trackerSlugs: { 'acme analytics': 'acme-analytics' },
  companySlugs: { 'acme corp': 'acme-corp' },
  jurisdictionData
};

test('production templates preserve the principal page states and data', () => {
  const home = render('form.pug', {
    headlines: { totalApps: 12, usOnlyPct: '50.0', noTrackersPct: '10.0', latestAnalysis: new Date('2026-09-07') },
    appsWithMostTrackers: [{ appid: 'com.example.app', title: 'Example App', trackerCount: 1 }],
    jurisdictionStats: {
      classificationCounts: { us_only: 6, no_tracking: 1 },
      classificationPcts: { us_only: '50.0', no_tracking: '8.3' }
    }
  });
  assertSingleH1(home, 'homepage');
  assert.match(home, /A closer look at your iPhone apps/);
  assert.match(home, /not random/);
  assert.match(home, /action="\/search"/);
  assert.match(home, /name="search"/);
  assert.match(home, /Example App/);

  const success = render('form.pug', reportBase);
  assertSingleH1(success, 'successful report');
  assert.match(success, /Acme Analytics/);
  assert.match(success, /Adid Access/);
  assert.match(success, /System API/);
  assert.match(success, /third-party tracker/);
  assert.match(success, /analytics\.example\.test/);
  assert.match(success, /Camera/);
  assert.match(success, /href="\/tracker\/acme-analytics"/);
  assert.match(success, /href="\/company\/acme-corp"/);

  const noTrackers = render('form.pug', {
    ...reportBase,
    app: { ...reportBase.app, analysis: { success: true, trackers: { 'Adid Access': {} } } },
    jurisdictionData: { classification: 'no_tracking', meta: labels.no_tracking, resolvedCount: 0, unresolvedCount: 0, regionBreakdown: {} },
    systemTrackerNames: ['Adid Access']
  });
  assert.match(noTrackers, />0<\/strong>[\s\S]*third-party trackers detected/);
  assert.match(noTrackers, /System API/);
  assert.doesNotMatch(noTrackers, /Unknown category/);

  const missing = render('form.pug', {
    ...reportBase,
    app: { ...reportBase.app, analysis: { success: true } },
    jurisdictionData: null
  });
  assert.match(missing, /Tracker data unavailable/);
  assert.match(missing, /Tracking domain data is unavailable/);
  assert.match(missing, /Permission data is unavailable/);
  assert.match(missing, /Unavailable/);

  const failed = render('form.pug', {
    ...reportBase,
    app: { ...reportBase.app, analysisFailure: 'Analysis failed.', analysis: { success: false, trackers: { 'Acme Analytics': {} } } }
  });
  assertSingleH1(failed, 'failed report');
  assert.match(failed, /Analysis failed/);
  assert.doesNotMatch(failed, /Tracking software/);
  assert.doesNotMatch(failed, /Acme Analytics/);

  const pending = render('form.pug', {
    app: {
      appid: 'com.example.pending', details: { title: 'Pending App', version: '2.0.0' },
      reportMetadata: { title: 'Pending App', queueVersion: '2.0.0', currentVersion: '2.0.0', currentVersionFromStorefront: false },
      queueCount: 0
    },
    analyserOnline: false
  });
  assert.match(pending, /Awaiting analysis/);
  assert.match(pending, /next in the analysis queue/);
  assert.match(pending, /currently offline/);
  assert.match(pending, /Queue-time version/);
});

test('search, directory, lookup, statistics, about, request and error states render safely', () => {
  const emptySearch = render('form.pug', { data: { search: 'nothing' }, searchResults: [] });
  assertSingleH1(emptySearch, 'empty search');
  assert.match(emptySearch, /No apps found for/);
  assert.match(emptySearch, /No matching free app/);

  const search = render('form.pug', {
    data: { search: 'example' },
    searchResults: [
      { appId: 'com.example.published', title: 'Published', free: true, inDatabase: true, version: '1' },
      { appId: 'com.example.new', title: 'New Free', free: true, inDatabase: false, version: '2' },
      { appId: 'com.example.paid', title: 'Paid', free: false, version: '3' }
    ]
  });
  assertSingleH1(search, 'search results');
  assert.match(search, /href="\/analysis\/com.example.published"/);
  assert.match(search, /href="\/request\/com.example.new"/);
  assert.match(search, /Paid apps cannot be analysed/);

  const directory = render('directory.pug', {
    kind: 'tracker',
    entries: [{ name: 'Acme Analytics', slug: 'acme-analytics', company: 'Acme Corp', companySlug: 'acme-corp', countryName: 'United States', region: 'US', appCount: 2, pct: '50.0' }],
    totalApps: 4, trackedApps: 2
  });
  assertSingleH1(directory, 'directory');
  assert.match(directory, /Acme Analytics/);
  assert.match(directory, /data-filter=/);

  const lookup = render('lookup.pug', {
    kind: 'tracker',
    entry: { name: 'Acme Analytics', company: 'Acme Corp', companySlug: 'acme-corp', countryName: 'United States', region: 'US', appCount: 2, pct: '50.0' },
    totalApps: 4,
    pagination: { apps: [{ appid: 'com.example.app', title: 'Example App', trackerCount: 1 }], total: 1, from: 1, to: 1, page: 1, totalPages: 1 }
  });
  assertSingleH1(lookup, 'lookup');
  assert.match(lookup, /Example App/);

  const statistics = render('statistics.pug', {
    headlines: { totalApps: 4 },
    jurisdictionStats: { totalApps: 4, classificationCounts: { no_tracking: 0 }, classificationPcts: { no_tracking: '0' }, topCompaniesSorted: [], categoriesSorted: [] },
    topTrackersEnriched: [], europeanAlternatives: []
  });
  assertSingleH1(statistics, 'statistics');
  assert.match(statistics, /Jurisdiction breakdown/);
  assert.match(statistics, /No tracker prevalence data/);
  assert.match(statistics, /European alternatives/);

  const about = render('about.pug');
  assertSingleH1(about, 'about');
  for (const anchor of ['how-it-works', 'sample', 'results', 'jurisdiction', 'limitations', 'disclaimer', 'background', 'contact'])
    assert.match(about, new RegExp(`id="${anchor}"`));
  assert.match(about, /not a random sample of the App Store/);
  assert.match(about, /confirms the request/);

  const request = render('request-analysis.pug', { appId: 'com.example.request' });
  assertSingleH1(request, 'request');
  assert.match(request, /Nothing is queued before you confirm/);
  assert.match(request, /method="POST"/);

  const error = render('error.pug', { status: 404, title: 'Not found', message: 'No such page.' });
  assertSingleH1(error, 'error');
  assert.match(error, /No such page/);
});

test('migrated output contains no legacy Bootstrap or inline event hooks', () => {
  const pages = [
    render('form.pug'), render('statistics.pug', { headlines: { totalApps: 0 }, jurisdictionStats: {} }),
    render('directory.pug', { kind: 'tracker', entries: [] }), render('about.pug'),
    render('request-analysis.pug', { appId: 'com.example.request' }), render('error.pug')
  ];
  for (const html of pages) {
    assert.doesNotMatch(html, /bootstrap|jquery|popper|data-toggle|onclick/i);
  }
});
