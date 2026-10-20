const assert = require('node:assert/strict');
const test = require('node:test');
const { wakeAnalyser, wakeUrl } = require('../lib/analyserWake');

test('wake-ups are disabled without a valid topic', () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(wakeUrl({ topic: '' }), null);
    assert.equal(wakeUrl({ topic: '   ' }), null);
    assert.equal(wakeUrl({ topic: 'a/b' }), null);
    assert.equal(wakeUrl({ topic: 'x'.repeat(65) }), null);
  } finally {
    console.error = originalConsoleError;
  }
});

test('the topic URL defaults to ntfy.sh and accepts a self-hosted server', () => {
  assert.equal(wakeUrl({ topic: 'tc-ios_42' }), 'https://ntfy.sh/tc-ios_42');
  assert.equal(wakeUrl({ topic: 'tc', server: 'https://ntfy.example.test//' }), 'https://ntfy.example.test/tc');
});

test('a wake-up posts a bare message to the topic', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body, headers: options.headers });
    return { ok: true, status: 200 };
  };
  assert.equal(await wakeAnalyser({ topic: 'tc', token: '', fetchImpl }), true);
  assert.equal(await wakeAnalyser({ topic: 'tc', token: 'tk_secret', fetchImpl }), true);
  assert.deepEqual(calls, [
    { url: 'https://ntfy.sh/tc', method: 'POST', body: 'wake', headers: {} },
    { url: 'https://ntfy.sh/tc', method: 'POST', body: 'wake', headers: { authorization: 'Bearer tk_secret' } },
  ]);
});

test('a failed wake-up is reported but never thrown', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(await wakeAnalyser({
      topic: 'tc',
      fetchImpl: async () => { throw new Error('offline'); }
    }), false);
    assert.equal(await wakeAnalyser({
      topic: 'tc',
      fetchImpl: async () => ({ ok: false, status: 429 })
    }), false);
  } finally {
    console.error = originalConsoleError;
  }
});

test('nothing is sent when no topic is configured', async () => {
  let called = false;
  assert.equal(await wakeAnalyser({
    topic: '',
    fetchImpl: async () => { called = true; }
  }), false);
  assert.equal(called, false);
});
