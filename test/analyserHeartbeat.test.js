const assert = require('node:assert/strict');
const test = require('node:test');

// Runs in its own process, so the server's one-off heartbeat read happens
// against the stubs below.
test('analyser status survives a restart through the stored heartbeat', async () => {
  process.env.UPLOAD_PASSWORD = 'test-secret';
  const Apps = require('../models/Apps');
  const original = {
    lastAnalyserHeartbeat: Apps.lastAnalyserHeartbeat,
    recordAnalyserHeartbeat: Apps.recordAnalyserHeartbeat,
  };
  let reads = 0;
  let writes = 0;
  Apps.lastAnalyserHeartbeat = async () => {
    reads++;
    return Date.now() - 10 * 60 * 1000;
  };
  Apps.recordAnalyserHeartbeat = async () => {
    writes++;
  };

  const app = require('../server');
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const first = await fetch(`${base}/healthz/analyser`);
    const second = await fetch(`${base}/healthz/analyser`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(reads, 1);

    const ping = await fetch(`${base}/ping`, {
      headers: { authorization: 'Bearer test-secret' }
    });
    assert.equal(ping.status, 200);
    assert.equal(writes, 1);
  } finally {
    Apps.lastAnalyserHeartbeat = original.lastAnalyserHeartbeat;
    Apps.recordAnalyserHeartbeat = original.recordAnalyserHeartbeat;
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
});
