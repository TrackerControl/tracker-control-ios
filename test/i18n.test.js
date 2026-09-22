'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canonicalUrl,
  createTranslator,
  formatDate,
  isPublicLocalizedPath,
  languageUrl,
  localUrl,
  localeForRequest
} = require('../lib/i18n');

test('Danish translation interpolates values and falls back to English', () => {
  const da = createTranslator('da');
  assert.equal(da('Search reports'), 'Søg i rapporter');
  assert.equal(da('United States'), 'USA');
  assert.equal(da('{{count}} apps', { count: 3 }), '3 apps');
  assert.equal(createTranslator('en')('Search reports'), 'Search reports');
});

test('request locale comes from the public path, never from query or cookies', () => {
  assert.deepEqual(localeForRequest({ originalUrl: '/da/statistics?lang=en', headers: {} }), { locale: 'da', fromQuery: false });
  assert.deepEqual(localeForRequest({ originalUrl: '/statistics?lang=da', headers: { cookie: 'tc_locale=da' } }), { locale: 'en', fromQuery: false });
});

test('language links preserve path and existing query parameters', () => {
  assert.equal(languageUrl('/tracker/acme?page=2&filter=all', 'da'), '/da/tracker/acme?page=2&filter=all');
  assert.equal(languageUrl('/da/tracker/acme?page=2&filter=all', 'en'), '/tracker/acme?page=2&filter=all');
  assert.equal(localUrl('?page=2#apps', 'da', '/tracker/acme'), '/da/tracker/acme?page=2#apps');
  assert.equal(canonicalUrl('https://example.test', '/statistics', 'da', { page: 2 }), 'https://example.test/da/statistics?page=2');
  assert.equal(canonicalUrl('https://example.test', '/statistics', 'en'), 'https://example.test/statistics');
});

test('only public website routes may be stripped from /da', () => {
  assert.equal(isPublicLocalizedPath('/da', 'GET'), true);
  assert.equal(isPublicLocalizedPath('/da/analysis/com.example.app', 'POST'), true);
  for (const path of ['/da/queue', '/da/ping', '/da/uploadAnalysis', '/da/reportAnalysisFailure', '/da/healthz', '/da/sitemap.xml', '/da/robots.txt', '/da/assets/app.css'])
    assert.equal(isPublicLocalizedPath(path, 'GET'), false, path);
});

test('Danish dates use the Danish locale', () => {
  const date = new Date('2026-09-08T10:00:00Z');
  assert.match(formatDate(date, 'da'), /2026/);
  assert.notEqual(formatDate(date, 'da'), formatDate(date, 'en'));
});
