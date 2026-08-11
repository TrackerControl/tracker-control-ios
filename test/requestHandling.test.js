'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Apps = require('../models/Apps');
const store = require('../lib/appStore');
const turnstile = require('../lib/turnstile');

process.env.UPLOAD_PASSWORD = 'test-secret';
process.env.BODY_LIMIT = '2kb';
process.env.PUBLIC_FORM_BODY_LIMIT = '100b';
process.env.TURNSTILE_SECRET = 'test-turnstile-secret';
process.env.TURNSTILE_HOSTNAMES = '127.0.0.1,localhost';

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
      const html = await response.text();
      assert.match(html, /The security check expired or failed\. Please try again\./);
      assert.match(html, /data-action="search_app"/);
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
  const originalFindApp = Apps.findApp;
  const originalCacheAppStoreResults = Apps.cacheAppStoreResults;
  let searchInput;
  let cachedResults;

  turnstile.validateTurnstile = async () => true;
  store.search = async (input) => {
    searchInput = input;
    return [
      {
        appId: 'com.example.known',
        title: 'Known App',
        icon: 'https://example.test/known.png',
        version: '1.0',
        free: true,
      },
      {
        appId: 'com.example.unknown',
        title: 'Unknown App',
        icon: 'https://example.test/unknown.png',
        version: '2.0',
        free: true,
      },
    ];
  };
  Apps.findApp = async (appId) => appId === 'com.example.known'
    ? { appid: appId }
    : null;
  Apps.cacheAppStoreResults = async (results) => {
    cachedResults = results;
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'search=test&cf-turnstile-response=valid-token'
      });

      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /href="\/analysis\/com\.example\.known"/);
      assert.match(html, /formaction="\/analysis\/com\.example\.unknown"/);
      assert.match(html, /data-action="request_analysis"/);
    });

    assert.deepEqual(searchInput, { term: 'test', num: 5, country: 'gb' });
    assert.equal(cachedResults.length, 2);
    assert.equal(cachedResults[1].appId, 'com.example.unknown');
  } finally {
    turnstile.validateTurnstile = originalValidateTurnstile;
    store.search = originalSearch;
    Apps.findApp = originalFindApp;
    Apps.cacheAppStoreResults = originalCacheAppStoreResults;
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

test('unknown app GET is database-only and renders an analysis request form', async () => {
  const originalFindApp = Apps.findApp;
  const originalStoreApp = store.app;
  let storeAppCalled = false;

  Apps.findApp = async () => null;
  store.app = async () => {
    storeAppCalled = true;
    throw new Error('should not be called');
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/analysis/com.example.unknown`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex');
      assert.match(html, /data-action="request_analysis"/);
      assert.match(html, /action="\/analysis\/com\.example\.unknown" method="POST"/);
    });
    assert.equal(storeAppCalled, false);
  } finally {
    Apps.findApp = originalFindApp;
    store.app = originalStoreApp;
  }
});

test('analysis request rejects invalid Turnstile before contacting Apple', async () => {
  const originalValidateTurnstile = turnstile.validateTurnstile;
  const originalStoreApp = store.app;
  let validationInput;
  let storeAppCalled = false;

  turnstile.validateTurnstile = async (input) => {
    validationInput = input;
    return false;
  };
  store.app = async () => {
    storeAppCalled = true;
    throw new Error('should not be called');
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/analysis/com.example.unknown`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'cf-turnstile-response=invalid-token'
      });

      assert.equal(response.status, 403);
      const html = await response.text();
      assert.match(html, /The security check expired or failed\. Please try again\./);
      assert.match(html, /data-action="request_analysis"/);
    });
    assert.equal(validationInput.token, 'invalid-token');
    assert.equal(validationInput.expectedAction, 'request_analysis');
    assert.equal(storeAppCalled, false);
  } finally {
    turnstile.validateTurnstile = originalValidateTurnstile;
    store.app = originalStoreApp;
  }
});

test('valid analysis request looks up, queues, and redirects to the canonical app', async () => {
  const originalValidateTurnstile = turnstile.validateTurnstile;
  const originalFindApp = Apps.findApp;
  const originalAddAppAndStorefront = Apps.addAppAndStorefront;
  const originalFindCachedAppStoreResult = Apps.findCachedAppStoreResult;
  const originalStoreApp = store.app;
  let added;

  turnstile.validateTurnstile = async () => true;
  Apps.findApp = async () => null;
  Apps.findCachedAppStoreResult = async () => null;
  Apps.addAppAndStorefront = async (...args) => {
    added = args;
    return { rowCount: 1 };
  };
  store.app = async () => ({
    appId: 'com.example.Canonical',
    title: 'Example App',
    free: true,
  });

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/analysis/com.example.canonical`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'cf-turnstile-response=valid-token',
        redirect: 'manual'
      });

      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/analysis/com.example.Canonical');
    });
    assert.equal(added[0], 'com.example.canonical');
    assert.equal(added[1].appId, 'com.example.Canonical');
  } finally {
    turnstile.validateTurnstile = originalValidateTurnstile;
    Apps.findApp = originalFindApp;
    Apps.addAppAndStorefront = originalAddAppAndStorefront;
    Apps.findCachedAppStoreResult = originalFindCachedAppStoreResult;
    store.app = originalStoreApp;
  }
});

test('analysis request reuses Apple metadata cached by search', async () => {
  const originalValidateTurnstile = turnstile.validateTurnstile;
  const originalFindApp = Apps.findApp;
  const originalAddApp = Apps.addApp;
  const originalFindCachedAppStoreResult = Apps.findCachedAppStoreResult;
  const originalStoreApp = store.app;
  let added;
  let storeAppCalled = false;

  const cachedDetails = {
    appId: 'com.example.Cached',
    title: 'Cached App',
    free: true,
  };
  turnstile.validateTurnstile = async () => true;
  Apps.findApp = async () => null;
  Apps.findCachedAppStoreResult = async () => cachedDetails;
  Apps.addApp = async (...args) => {
    added = args;
    return { rowCount: 1 };
  };
  store.app = async () => {
    storeAppCalled = true;
    throw new Error('should not be called');
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/analysis/com.example.cached`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'cf-turnstile-response=valid-token',
        redirect: 'manual'
      });

      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/analysis/com.example.Cached');
    });
    assert.equal(added[1].title, 'Cached App');
    assert.equal(storeAppCalled, false);
  } finally {
    turnstile.validateTurnstile = originalValidateTurnstile;
    Apps.findApp = originalFindApp;
    Apps.addApp = originalAddApp;
    Apps.findCachedAppStoreResult = originalFindCachedAppStoreResult;
    store.app = originalStoreApp;
  }
});

test('analysis report GET uses database metadata only and renders provenance labels', async () => {
  const originalFindApp = Apps.findApp;
  const originalStoreApp = store.app;
  let storeAppCalled = false;

  Apps.findApp = async () => ({
    appid: 'com.example.Report',
    details: {
      appId: 'com.example.Report',
      title: 'Queue title',
      icon: 'https://example.test/queue.png',
      url: 'https://example.test/queue',
      version: '1.0'
    },
    analysis: { success: true, trackers: {} },
    analysed: new Date('2026-08-01T12:00:00Z'),
    analysis_app_version: '1.0',
    current_storefront_details: {
      appId: 'com.example.Report',
      title: 'Current title',
      icon: 'https://example.test/current.png',
      url: 'https://example.test/current',
      version: '1.2'
    },
    current_fetched_at: new Date('2026-08-10T12:00:00Z')
  });
  store.app = async () => {
    storeAppCalled = true;
    throw new Error('GET must not call Apple');
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/analysis/com.example.Report`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /Current title/);
      assert.match(html, /Analysed version 1\.0/);
      assert.match(html, /Current App Store version 1\.2/);
      assert.match(html, /checked/);
      assert.match(html, /https:\/\/example\.test\/current/);
    });
    assert.equal(storeAppCalled, false);
  } finally {
    Apps.findApp = originalFindApp;
    store.app = originalStoreApp;
  }
});

test('queued analysis page keeps queue metadata without an analysed label', async () => {
  const originalFindApp = Apps.findApp;
  const originalCountQueue = Apps.countQueue;

  Apps.findApp = async () => ({
    appid: 'com.example.Queued',
    details: {
      appId: 'com.example.Queued',
      title: 'Queued App',
      icon: 'https://example.test/queued.png',
      url: 'https://example.test/queued',
      version: '1.0'
    },
    analysis: null,
    added: new Date('2026-08-01T12:00:00Z'),
    analysed: null,
    current_storefront_details: null,
    current_fetched_at: null
  });
  Apps.countQueue = async () => 3;

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/analysis/com.example.Queued`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /Version 1\.0/);
      assert.doesNotMatch(html, /Analysed version/);
      assert.match(html, /The app is queued for analysis/);
    });
  } finally {
    Apps.findApp = originalFindApp;
    Apps.countQueue = originalCountQueue;
  }
});

test('direct analysis lookup seeds the cache and app in one application call', async () => {
  const originalValidateTurnstile = turnstile.validateTurnstile;
  const originalFindApp = Apps.findApp;
  const originalAddApp = Apps.addApp;
  const originalAddAppAndStorefront = Apps.addAppAndStorefront;
  const originalFindCachedAppStoreResult = Apps.findCachedAppStoreResult;
  const originalStoreApp = store.app;
  let seeded;

  turnstile.validateTurnstile = async () => true;
  Apps.findApp = async () => null;
  Apps.findCachedAppStoreResult = async () => null;
  Apps.addApp = async () => {
    throw new Error('direct Apple lookup must use the transactional seed');
  };
  Apps.addAppAndStorefront = async (...args) => {
    seeded = args;
    return { rowCount: 1 };
  };
  store.app = async () => ({
    appId: 'com.example.Direct',
    title: 'Direct App',
    free: true,
    version: '3.0'
  });

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/analysis/com.example.direct`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'cf-turnstile-response=valid-token',
        redirect: 'manual'
      });

      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/analysis/com.example.Direct');
    });
    assert.equal(seeded[0], 'com.example.direct');
    assert.equal(seeded[1].appId, 'com.example.Direct');
  } finally {
    turnstile.validateTurnstile = originalValidateTurnstile;
    Apps.findApp = originalFindApp;
    Apps.addApp = originalAddApp;
    Apps.addAppAndStorefront = originalAddAppAndStorefront;
    Apps.findCachedAppStoreResult = originalFindCachedAppStoreResult;
    store.app = originalStoreApp;
  }
});

test('direct lookup caches a paid App Store response without enqueueing it', async () => {
  const originalValidateTurnstile = turnstile.validateTurnstile;
  const originalFindApp = Apps.findApp;
  const originalFindCachedAppStoreResult = Apps.findCachedAppStoreResult;
  const originalCacheAppStoreResults = Apps.cacheAppStoreResults;
  const originalAddAppAndStorefront = Apps.addAppAndStorefront;
  const originalStoreApp = store.app;
  let cached;
  let added = false;

  turnstile.validateTurnstile = async () => true;
  Apps.findApp = async () => null;
  Apps.findCachedAppStoreResult = async () => null;
  Apps.cacheAppStoreResults = async (results) => {
    cached = results;
  };
  Apps.addAppAndStorefront = async () => {
    added = true;
  };
  store.app = async () => ({
    appId: 'com.example.Paid',
    title: 'Paid App',
    free: false,
    version: '3.0'
  });

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/analysis/com.example.paid`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'cf-turnstile-response=valid-token'
      });

      assert.equal(response.status, 400);
      assert.match(await response.text(), /Can\'t analyse non-free apps/);
    });
    assert.equal(cached[0].appId, 'com.example.Paid');
    assert.equal(added, false);
  } finally {
    turnstile.validateTurnstile = originalValidateTurnstile;
    Apps.findApp = originalFindApp;
    Apps.findCachedAppStoreResult = originalFindCachedAppStoreResult;
    Apps.cacheAppStoreResults = originalCacheAppStoreResults;
    Apps.addAppAndStorefront = originalAddAppAndStorefront;
    store.app = originalStoreApp;
  }
});
