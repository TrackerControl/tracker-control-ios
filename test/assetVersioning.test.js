const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.CLOUDFLARE_ORIGIN_SECRET = '';
const app = require('../server');

test('public pages reference content-versioned assets that serve the matching files', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const files = ['css/styles.css', 'js/filter.js', 'js/site.js', 'images/trackercontrol.png'];
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(fs.readFileSync(path.join(__dirname, '../public', file)));
  const prefix = `/assets/${hash.digest('hex').slice(0, 16)}`;
  const page = await fetch(base + '/missing-page-for-asset-test');
  assert.equal(page.status, 404);
  const html = await page.text();
  for (const file of files) {
    assert.ok(html.includes(prefix + '/' + file));
    const response = await fetch(base + prefix + '/' + file);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(__dirname, '../public', file)));
  }
});
