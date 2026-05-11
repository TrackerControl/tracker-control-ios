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
