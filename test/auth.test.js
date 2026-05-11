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
