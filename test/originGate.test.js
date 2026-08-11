'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ORIGIN_HEADER,
  assertOriginConfiguration,
  getOriginSecret,
  hasOriginSecret,
  originGate,
} = require('../lib/originGate');

function fakeRequest({ path = '/search', headers = {} } = {}) {
  const lower = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;

  return {
    path,
    get: (name) => lower[name.toLowerCase()],
  };
}

function runGate(req, options) {
  let nextCalled = false;
  let status;
  let body;
  const res = {
    status(code) { status = code; return res; },
    send(payload) { body = payload; return res; },
  };

  originGate(options)(req, res, () => { nextCalled = true; });
  return { nextCalled, status, body };
}

test('origin configuration reports a missing secret', () => {
  assert.equal(getOriginSecret({ secret: '   ' }), null);
  assert.throws(
    () => assertOriginConfiguration({ secret: '' }),
    /CLOUDFLARE_ORIGIN_SECRET is not set/
  );
  assert.equal(getOriginSecret({ secret: ' shared ' }), 'shared');
});

test('the header comparison rejects wrong and truncated values', () => {
  const options = { secret: 'shared-secret' };

  assert.equal(hasOriginSecret(fakeRequest({ headers: { [ORIGIN_HEADER]: 'shared-secret' } }), options), true);
  assert.equal(hasOriginSecret(fakeRequest({ headers: { [ORIGIN_HEADER]: 'shared-secre' } }), options), false);
  assert.equal(hasOriginSecret(fakeRequest({ headers: { [ORIGIN_HEADER]: 'wrong-secret!' } }), options), false);
  assert.equal(hasOriginSecret(fakeRequest(), options), false);
  assert.equal(hasOriginSecret(fakeRequest({ headers: { [ORIGIN_HEADER]: 'anything' } }), { secret: '' }), false);
});

test('requests that skipped Cloudflare are refused', () => {
  const options = { secret: 'shared-secret' };

  const blocked = runGate(fakeRequest({ path: '/search' }), options);
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body, /public domain/);

  const allowed = runGate(
    fakeRequest({ path: '/search', headers: { [ORIGIN_HEADER]: 'shared-secret' } }),
    options
  );
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.status, undefined);
});

test('a skip predicate lets the authenticated analyser reach the origin directly', () => {
  const options = {
    secret: 'shared-secret',
    skip: (req) => req.path === '/queue' && req.get('authorization') === 'Bearer analyser',
  };

  assert.equal(
    runGate(fakeRequest({ path: '/queue', headers: { authorization: 'Bearer analyser' } }), options).nextCalled,
    true
  );
  assert.equal(runGate(fakeRequest({ path: '/queue' }), options).status, 403);
  assert.equal(
    runGate(fakeRequest({ path: '/search', headers: { authorization: 'Bearer analyser' } }), options).status,
    403
  );
});

test('health checks stay reachable and an unset secret disables the gate', () => {
  const options = { secret: 'shared-secret' };

  for (const path of ['/healthz', '/healthz/', '/healthz/analyser', '/HEALTHZ']) {
    assert.equal(runGate(fakeRequest({ path }), options).nextCalled, true, path);
  }

  assert.equal(runGate(fakeRequest({ path: '/search' }), { secret: '' }).nextCalled, true);
});
