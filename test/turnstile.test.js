'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_TOKEN_LENGTH,
  SITEVERIFY_URL,
  assertTurnstileConfiguration,
  getTurnstileConfigurationError,
  parseExpectedHostnames,
  validateTurnstile,
} = require('../lib/turnstile');

test('Turnstile configuration reports missing production variables', () => {
  assert.equal(
    getTurnstileConfigurationError({ secret: '', hostnames: 'localhost' }),
    'TURNSTILE_SECRET is not set'
  );
  assert.equal(
    getTurnstileConfigurationError({ secret: 'secret', hostnames: '' }),
    'TURNSTILE_HOSTNAMES is not set'
  );
  assert.throws(
    () => assertTurnstileConfiguration({ secret: '', hostnames: 'localhost' }),
    /TURNSTILE_SECRET is not set/
  );
});

test('parseExpectedHostnames trims entries and drops empty values', () => {
  assert.deepEqual(
    [...parseExpectedHostnames(' ios.trackercontrol.org, localhost, ,')],
    ['ios.trackercontrol.org', 'localhost']
  );
});

test('validateTurnstile verifies the token, action, hostname, and remote IP', async () => {
  let request;
  const valid = await validateTurnstile({
    token: 'valid-token',
    remoteIp: '203.0.113.10',
    expectedAction: 'search_app',
    secret: 'secret',
    hostnames: 'ios.trackercontrol.org,localhost',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          success: true,
          action: 'search_app',
          hostname: 'ios.trackercontrol.org',
        }),
      };
    },
  });

  assert.equal(valid, true);
  assert.equal(request.url, SITEVERIFY_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(request.options.body.get('secret'), 'secret');
  assert.equal(request.options.body.get('response'), 'valid-token');
  assert.equal(request.options.body.get('remoteip'), '203.0.113.10');
  assert.ok(request.options.signal instanceof AbortSignal);
});

test('validateTurnstile fails closed before calling Siteverify for invalid configuration', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new Error('should not be called');
  };
  const base = {
    token: 'token',
    expectedAction: 'search_app',
    secret: 'secret',
    hostnames: 'ios.trackercontrol.org',
    fetchImpl,
  };

  assert.equal(await validateTurnstile({ ...base, token: '' }), false);
  assert.equal(await validateTurnstile({ ...base, token: 'x'.repeat(MAX_TOKEN_LENGTH + 1) }), false);
  assert.equal(await validateTurnstile({ ...base, secret: '' }), false);
  assert.equal(await validateTurnstile({ ...base, hostnames: '' }), false);
  assert.equal(await validateTurnstile({ ...base, expectedAction: '' }), false);
  assert.equal(calls, 0);
});

test('validateTurnstile rejects an unexpected action or hostname', async () => {
  const result = {
    success: true,
    action: 'different_action',
    hostname: 'attacker.example',
  };
  const fetchImpl = async () => ({ ok: true, json: async () => result });
  const base = {
    token: 'token',
    expectedAction: 'search_app',
    secret: 'secret',
    hostnames: 'ios.trackercontrol.org',
    fetchImpl,
  };

  assert.equal(await validateTurnstile(base), false);
  result.action = 'search_app';
  assert.equal(await validateTurnstile(base), false);
  result.hostname = 'ios.trackercontrol.org';
  assert.equal(await validateTurnstile(base), true);
});

test('validateTurnstile rejects Siteverify errors and unsuccessful responses', async () => {
  const base = {
    token: 'token',
    expectedAction: 'search_app',
    secret: 'secret',
    hostnames: 'ios.trackercontrol.org',
  };

  assert.equal(await validateTurnstile({
    ...base,
    fetchImpl: async () => ({ ok: false }),
  }), false);
  assert.equal(await validateTurnstile({
    ...base,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ success: false }),
    }),
  }), false);
  assert.equal(await validateTurnstile({
    ...base,
    fetchImpl: async () => { throw new Error('network unavailable'); },
  }), false);
});
