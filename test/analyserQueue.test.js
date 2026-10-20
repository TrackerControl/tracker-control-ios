const assert = require('node:assert/strict');
const test = require('node:test');

// Runs in its own process, so the server's one-off heartbeat read happens
// against the stubs below.
process.env.UPLOAD_PASSWORD = 'test-secret';
process.env.NTFY_TOPIC = 'tc-test-topic';
const Apps = require('../models/Apps');
const store = require('../lib/appStore');

const state = { reads: 0, writes: 0, nextApp: null, nextDue: null };
Apps.lastAnalyserHeartbeat = async () => {
  state.reads++;
  return Date.now() - 20 * 60 * 60 * 1000;
};
Apps.recordAnalyserHeartbeat = async () => { state.writes++; };
Apps.nextApp = async () => state.nextApp;
Apps.nextDueAt = async () => state.nextDue;

const wakeUps = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://ntfy.sh/')) {
    wakeUps.push({ url: String(url), body: options.body });
    return { ok: true, status: 200 };
  }
  return realFetch(url, options);
};

const app = require('../server');

async function withServer(run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

const auth = { authorization: 'Bearer test-secret' };

test('a stored check-in from the last day keeps the analyser online across restarts', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/healthz/analyser`)).status, 200);
    assert.equal((await fetch(`${base}/healthz/analyser`)).status, 200);
  });
  assert.equal(state.reads, 1);
});

test('an empty queue tells the analyser when the next app falls due', async () => {
  const originalConsoleLog = console.log;
  console.log = () => {};
  try {
    await withServer(async (base) => {
      state.nextApp = null;
      state.nextDue = new Date(Date.now() + 3600 * 1000);
      const due = await fetch(`${base}/queue`, { headers: auth });
      assert.equal(due.status, 200);
      assert.equal(await due.text(), '');
      const seconds = Number(due.headers.get('x-analysis-next-due-seconds'));
      assert.ok(seconds > 3590 && seconds <= 3600, String(seconds));

      state.nextDue = new Date(Date.now() - 1000);
      const overdue = await fetch(`${base}/queue`, { headers: auth });
      assert.equal(overdue.headers.get('x-analysis-next-due-seconds'), '0');

      state.nextDue = null;
      const never = await fetch(`${base}/queue`, { headers: auth });
      assert.equal(never.headers.get('x-analysis-next-due-seconds'), null);

      state.nextApp = { appid: 'com.example.app', analysis_claim_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
      state.nextDue = new Date(Date.now() + 3600 * 1000);
      const claimed = await fetch(`${base}/queue`, { headers: auth });
      assert.equal(await claimed.text(), 'com.example.app');
      assert.equal(claimed.headers.get('x-analysis-next-due-seconds'), null);
    });
  } finally {
    console.log = originalConsoleLog;
  }
  assert.equal(state.writes, 4);
});

test('the separate ping endpoint is gone', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/ping`, { headers: { ...auth, accept: 'text/plain' } });
    assert.equal(response.status, 404);
  });
});

test('queueing an app wakes the analyser', async () => {
  const original = {
    findApp: Apps.findApp,
    findCachedAppStoreResult: Apps.findCachedAppStoreResult,
    addAppAndStorefront: Apps.addAppAndStorefront,
    storeApp: store.app,
  };
  Apps.findApp = async () => null;
  Apps.findCachedAppStoreResult = async () => null;
  Apps.addAppAndStorefront = async () => ({ rowCount: 1 });
  store.app = async () => ({ appId: 'com.example.Wake', title: 'Wake', free: true });
  wakeUps.length = 0;

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/analysis/com.example.wake`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'manual'
      });
      assert.equal(response.status, 303);
    });
  } finally {
    Apps.findApp = original.findApp;
    Apps.findCachedAppStoreResult = original.findCachedAppStoreResult;
    Apps.addAppAndStorefront = original.addAppAndStorefront;
    store.app = original.storeApp;
  }
  assert.deepEqual(wakeUps, [{ url: 'https://ntfy.sh/tc-test-topic', body: 'wake' }]);
});
