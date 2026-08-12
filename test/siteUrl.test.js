'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const siteUrl = require('../lib/siteUrl');

function withEnv(values, run) {
  const original = { SITE_URL: process.env.SITE_URL, NODE_ENV: process.env.NODE_ENV };
  Object.assign(process.env, values);
  for (const [key, value] of Object.entries(values))
    if (value === undefined) delete process.env[key];

  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const request = (protocol, host) => ({ protocol, get: () => host });

test('production refuses to resolve a base URL from the request', () => {
  withEnv({ NODE_ENV: 'production', SITE_URL: undefined }, () => {
    assert.equal(siteUrl.getSiteUrlConfigurationError(), 'SITE_URL is not set');
    assert.throws(() => siteUrl.assertSiteUrlConfiguration(), /SITE_URL is not set/);
    // An untrusted Host header must not become a public canonical URL.
    assert.throws(() => siteUrl.siteBaseUrl(request('http', 'evil.test')), /SITE_URL is not set/);
  });
});

test('a blank SITE_URL counts as unset in production', () => {
  withEnv({ NODE_ENV: 'production', SITE_URL: '   ' }, () => {
    assert.equal(siteUrl.getSiteUrlConfigurationError(), 'SITE_URL is not set');
  });
});

test('a configured SITE_URL wins over the request and loses its trailing slashes', () => {
  withEnv({ NODE_ENV: 'production', SITE_URL: 'https://ios.example.org//' }, () => {
    assert.equal(siteUrl.getSiteUrlConfigurationError(), null);
    assert.equal(
      siteUrl.siteBaseUrl(request('http', 'evil.test')),
      'https://ios.example.org'
    );
  });
});

test('development falls back to the request origin', () => {
  withEnv({ NODE_ENV: 'development', SITE_URL: undefined }, () => {
    assert.equal(siteUrl.getSiteUrlConfigurationError(), null);
    assert.equal(
      siteUrl.siteBaseUrl(request('http', 'localhost:3000')),
      'http://localhost:3000'
    );
  });
});
