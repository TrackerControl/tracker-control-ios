'use strict';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;
const SITEVERIFY_TIMEOUT_MS = 10_000;

function getTurnstileConfigurationError({
  secret = process.env.TURNSTILE_SECRET,
  hostnames = process.env.TURNSTILE_HOSTNAMES,
} = {}) {
  if (typeof secret !== 'string' || secret.trim().length === 0)
    return 'TURNSTILE_SECRET is not set';

  if (parseExpectedHostnames(hostnames).size === 0)
    return 'TURNSTILE_HOSTNAMES is not set';

  return null;
}

function assertTurnstileConfiguration(config) {
  const error = getTurnstileConfigurationError(config);
  if (error) throw new Error(error);
}

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
  logger = console,
}) {
  const expectedHostnames = parseExpectedHostnames(hostnames);

  const configurationError = getTurnstileConfigurationError({ secret, hostnames });
  if (configurationError) {
    if (logger && typeof logger.error === 'function')
      logger.error(`Turnstile configuration error: ${configurationError}`);
    return false;
  }

  if (typeof token !== 'string'
      || token.length === 0
      || token.length > MAX_TOKEN_LENGTH
      || typeof expectedAction !== 'string'
      || expectedAction.length === 0
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
  assertTurnstileConfiguration,
  getTurnstileConfigurationError,
  parseExpectedHostnames,
  validateTurnstile,
};
