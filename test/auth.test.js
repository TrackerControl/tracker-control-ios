const assert = require('node:assert/strict');
const test = require('node:test');

test('analyser endpoints accept bearer auth and reject missing auth', async () => {
  process.env.UPLOAD_PASSWORD = 'test-secret';
  const app = require('../server');

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headerResponse = await fetch(`${base}/ping`, {
      headers: { authorization: 'Bearer test-secret' }
    });
    const queryResponse = await fetch(`${base}/ping?password=test-secret`);
    const missingResponse = await fetch(`${base}/ping`);

    assert.equal(headerResponse.status, 200);
    assert.equal(queryResponse.status, 400);
    assert.equal(missingResponse.status, 400);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
});

test('analysis upload rejects a stale claim with conflict', async () => {
  process.env.UPLOAD_PASSWORD = 'test-secret';
  const Apps = require('../models/Apps');
  const originalUpdateAnalysis = Apps.updateAnalysis;
  const claimToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  Apps.updateAnalysis = async (appId, analysis, analysisVersion, token) => {
    assert.equal(appId, 'com.example.app');
    assert.deepEqual(analysis, { success: true, trackers: {} });
    assert.equal(analysisVersion, '4');
    assert.equal(token, claimToken);
    return { rowCount: 0, rows: [] };
  };

  const app = require('../server');
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/uploadAnalysis?appId=com.example.app&analysisVersion=4`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
          'x-analysis-claim-token': claimToken
        },
        body: JSON.stringify({ success: true, trackers: {} })
      }
    );

    assert.equal(response.status, 409);
    assert.match(await response.text(), /claim is no longer active/i);
  } finally {
    Apps.updateAnalysis = originalUpdateAnalysis;
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
});
