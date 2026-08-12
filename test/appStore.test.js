const assert = require('node:assert/strict');
const test = require('node:test');
const store = require('../lib/appStore');

test('lookup uses the UK App Store storefront', async () => {
  const app = await store.app({
    appId: 'net.whatsapp.WhatsApp',
    country: 'gb'
  });

  assert.equal(app.appId, 'net.whatsapp.WhatsApp');
  assert.equal(app.currency, 'GBP');
  assert.match(app.url, /apps\.apple\.com\/gb\//);
  assert.equal(app.free, true);
});

test('an unknown bundle ID is reported as absence, not as a transport status', async () => {
  const error = await store.app({
    appId: 'com.example.definitely.not.a.real.app.zzz999',
    country: 'gb'
  }).then(() => null, (err) => err);

  assert.ok(error, 'expected the lookup to reject');
  assert.equal(error.absent, true);
  assert.equal(error.statusCode, undefined);
});

test('search returns normalized UK App Store results', async () => {
  const results = await store.search({
    term: 'whatsapp',
    num: 1,
    country: 'gb'
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].currency, 'GBP');
  assert.ok(results[0].appId);
  assert.ok(results[0].title);
  assert.ok(results[0].icon);
});
