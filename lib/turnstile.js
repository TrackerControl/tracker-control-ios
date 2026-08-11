'use strict';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;
const SITEVERIFY_TIMEOUT_MS = 10_000;

function parseExpectedHostnames(value) {
  if (typeof value !== 'string') return new Set();

  return new Set(value
    .split(',')
    .map((hostname) => hostname.trim())
    .filter(Boolean));
}

async function validateTurnstile({
  token,
  remoteIp,
  expectedAction,
  secret = process.env.TURNSTILE_SECRET,
  hostnames = process.env.TURNSTILE_HOSTNAMES,
  fetchImpl = globalThis.fetch,
}) {
  const expectedHostnames = parseExpectedHostnames(hostnames);

  if (typeof token !== 'string'
      || token.length === 0
      || token.length > MAX_TOKEN_LENGTH
      || typeof secret !== 'string'
      || secret.trim().length === 0
      || typeof expectedAction !== 'string'
      || expectedAction.length === 0
      || expectedHostnames.size === 0
      || typeof fetchImpl !== 'function') {
    return false;
  }

  const body = new URLSearchParams({
    secret,
    response: token,
  });
  if (typeof remoteIp === 'string' && remoteIp.length > 0)
    body.set('remoteip', remoteIp);

  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      body,
    });
    if (!response.ok) return false;

    const result = await response.json();
    return result.success === true
      && result.action === expectedAction
      && expectedHostnames.has(result.hostname);
  } catch {
    return false;
  }
}

module.exports = {
  MAX_TOKEN_LENGTH,
  SITEVERIFY_URL,
  parseExpectedHostnames,
  validateTurnstile,
};
