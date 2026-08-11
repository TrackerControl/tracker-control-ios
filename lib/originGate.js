'use strict';

const crypto = require('crypto');

// Bot protection lives in Cloudflare WAF rules, which only help if the origin
// cannot be reached directly. A Cloudflare Transform Rule adds this header to
// every request for the zone, so anything arriving without it bypassed the edge.
const ORIGIN_HEADER = 'x-origin-verify';

// Railway probes the container directly, so its health checks never carry the
// header and must stay reachable.
const EXEMPT_PATHS = new Set(['/healthz', '/healthz/analyser']);

function getOriginSecret({ secret = process.env.CLOUDFLARE_ORIGIN_SECRET } = {}) {
  return typeof secret === 'string' && secret.trim().length > 0 ? secret.trim() : null;
}

function assertOriginConfiguration(options) {
  if (!getOriginSecret(options))
    throw new Error('CLOUDFLARE_ORIGIN_SECRET is not set');
}

function isExemptPath(req) {
  return EXEMPT_PATHS.has(req.path.toLowerCase().replace(/\/+$/, ''));
}

function hasOriginSecret(req, options = {}) {
  const secret = getOriginSecret(options);
  if (!secret) return false;

  const provided = req.get(ORIGIN_HEADER);
  if (typeof provided !== 'string') return false;

  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Without a configured secret the gate is inert, so local development and the
// test suite keep working without Cloudflare in front of them. `skip` exempts
// callers that legitimately reach the origin without the edge header.
function originGate(options = {}) {
  const { skip } = options;

  return (req, res, next) => {
    if (!getOriginSecret(options)) return next();
    if (isExemptPath(req)) return next();
    if (typeof skip === 'function' && skip(req)) return next();
    if (hasOriginSecret(req, options)) return next();

    return res.status(403).send('This site must be reached through its public domain.');
  };
}

module.exports = {
  ORIGIN_HEADER,
  assertOriginConfiguration,
  getOriginSecret,
  hasOriginSecret,
  originGate,
};
