const assert = require('node:assert/strict');
const test = require('node:test');
const { isSameAppId, isValidAppId } = require('../lib/appId');
const store = require('../lib/appStore');

test('accepts App Store bundle identifiers used by the analyser', () => {
  assert.equal(isValidAppId('app.organicmaps'), true);
  assert.equal(isValidAppId('pl.nestbank.nestbank-prod'), true);
  assert.equal(isValidAppId('com.substack.Substack'), true);
});

test('rejects malformed bundle identifiers observed in the production queue', () => {
  assert.equal(isValidAppId('app.organicmaps&quot'), false);
  assert.equal(isValidAppId('pl.nestbank.nestbank-prod&sa=U&ved=redirect'), false);
  assert.equal(isValidAppId('com.substack.Substack&sa=U&ved=redirect'), false);
  assert.equal(isValidAppId('.com.emf.detector.radiation.meter'), false);
});

test('rejects unsafe or structurally invalid bundle identifiers', () => {
  assert.equal(isValidAppId(''), false);
  assert.equal(isValidAppId('com.example.app.'), false);
  assert.equal(isValidAppId('com/example/app'), false);
  assert.equal(isValidAppId('com.example.app?source=search'), false);
  assert.equal(isValidAppId(`com.example.${'a'.repeat(245)}`), false);
});

test('matches bundle identifiers case-insensitively, as the App Store does', () => {
  assert.equal(isSameAppId('com.substack.substack', 'com.substack.Substack'), true);
  assert.equal(isSameAppId('app.organicmaps', 'app.organicmaps'), true);
  assert.equal(isSameAppId('app.organicmaps', 'app.organicmaps&quot'), false);
  assert.equal(isSameAppId('app.organicmaps', undefined), false);
});

test('App Store lookup rejects malformed IDs before making a request', async () => {
  await assert.rejects(
    store.app({ appId: 'app.organicmaps&quot', country: 'gb' }),
    /Invalid App Store bundle ID/
  );
});

test('analysis route rejects malformed IDs before database lookup', async () => {
  const app = require('../server');
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/analysis/app.organicmaps%26quot`
    );
    assert.equal(response.status, 400);
    assert.match(await response.text(), /valid App Store bundle ID/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
});
