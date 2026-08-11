'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Apps = require('../models/Apps');
const store = require('../lib/appStore');
const turnstile = require('../lib/turnstile');

process.env.UPLOAD_PASSWORD = 'test-secret';
process.env.BODY_LIMIT = '2kb';
process.env.PUBLIC_FORM_BODY_LIMIT = '100b';

const app = require('../server');

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

test('rejected async route promises reach centralized error middleware', async () => {
  const originalNextApp = Apps.nextApp;
  const originalConsoleError = console.error;
  Apps.nextApp = async () => {
    throw new Error('database unavailable');
  };
  console.error = () => {};

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/queue`, {
        headers: { authorization: 'Bearer test-secret' }
      });

      assert.equal(response.status, 500);
      assert.equal(await response.text(), 'Internal server error.');
    });
  } finally {
    Apps.nextApp = originalNextApp;
    console.error = originalConsoleError;
  }
});

test('large body parsers are scoped to authenticated analyser endpoints', async () => {
  const originalUpdateAnalysis = Apps.updateAnalysis;
  const originalConsoleLog = console.log;
  const updates = [];
  Apps.updateAnalysis = async (...args) => {
    updates.push(args);
    return 'updated';
  };
  console.log = () => {};

  const jsonPayload = JSON.stringify({ report: 'x'.repeat(250) });
  const textPayload = 'failure log '.repeat(30);
  const oversizedPayload = JSON.stringify({ report: 'x'.repeat(2100) });

  try {
    await withServer(async (base) => {
      const missingResponse = await fetch(`${base}/does-not-exist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversizedPayload
      });
      assert.equal(missingResponse.status, 404);

      const unauthenticatedResponse = await fetch(
        `${base}/uploadAnalysis?appId=com.example.app&analysisVersion=1`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: oversizedPayload
        }
      );
      assert.equal(unauthenticatedResponse.status, 400);

      const publicFormResponse = await fetch(`${base}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `search=${'x'.repeat(120)}`
      });
      assert.equal(publicFormResponse.status, 413);

      const uploadResponse = await fetch(
        `${base}/uploadAnalysis?appId=com.example.app&analysisVersion=1`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-secret',
            'content-type': 'application/json',
            'x-analysis-claim-token': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          },
          body: jsonPayload
        }
      );
      assert.equal(uploadResponse.status, 200);
      assert.deepEqual(await uploadResponse.json(), { ok: true });

      const failureResponse = await fetch(
        `${base}/reportAnalysisFailure?appId=com.example.app&analysisVersion=1`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-secret',
            'content-type': 'text/plain',
            'x-analysis-claim-token': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          },
          body: textPayload
        }
      );
      assert.equal(failureResponse.status, 200);
      assert.deepEqual(await failureResponse.json(), { ok: true });

      const oversizedUploadResponse = await fetch(
        `${base}/uploadAnalysis?appId=com.example.app&analysisVersion=1`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-secret',
            'content-type': 'application/json'
          },
          body: oversizedPayload
        }
      );
      assert.equal(oversizedUploadResponse.status, 413);

      assert.equal(updates.length, 2);
      assert.deepEqual(updates[0].slice(0, 2), [
        'com.example.app',
        JSON.parse(jsonPayload)
      ]);
      assert.equal(updates[1][0], 'com.example.app');
      assert.equal(updates[1][1].logs, textPayload);
    });
  } finally {
    Apps.updateAnalysis = originalUpdateAnalysis;
    console.log = originalConsoleLog;
  }
});

test('search rejects requests that fail Turnstile validation', async () => {
  const originalValidateTurnstile = turnstile.validateTurnstile;
  const originalSearch = store.search;
  let validationInput;
  let searchCalled = false;

  turnstile.validateTurnstile = async (input) => {
    validationInput = input;
    return false;
  };
  store.search = async () => {
    searchCalled = true;
    return [];
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'search=test&cf-turnstile-response=invalid-token'
      });

      assert.equal(response.status, 403);
      assert.equal(await response.text(), 'forbidden');
    });

    assert.equal(validationInput.token, 'invalid-token');
    assert.equal(validationInput.expectedAction, 'search_app');
    assert.match(validationInput.remoteIp, /127\.0\.0\.1/);
    assert.equal(searchCalled, false);
  } finally {
    turnstile.validateTurnstile = originalValidateTurnstile;
    store.search = originalSearch;
  }
});

test('search continues after successful Turnstile validation', async () => {
  const originalValidateTurnstile = turnstile.validateTurnstile;
  const originalSearch = store.search;
  let searchInput;

  turnstile.validateTurnstile = async () => true;
  store.search = async (input) => {
    searchInput = input;
    return [];
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'search=test&cf-turnstile-response=valid-token'
      });

      assert.equal(response.status, 200);
    });

    assert.deepEqual(searchInput, { term: 'test', num: 5, country: 'gb' });
  } finally {
    turnstile.validateTurnstile = originalValidateTurnstile;
    store.search = originalSearch;
  }
});

test('public pages load the Turnstile widget with compatible CSP directives', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/about`);
    const html = await response.text();
    const csp = response.headers.get('content-security-policy');

    assert.equal(response.status, 200);
    assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /connect-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.match(html, /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
    assert.match(html, /data-sitekey="0x4AAAAAAEM-nOb30hisDzEI"/);
    assert.match(html, /data-action="search_app"/);
    assert.match(html, /data-appearance="interaction-only"/);
  });
});
