'use strict';

// A new analysis changes the pages built from it, but those pages are cached
// at the Cloudflare edge and nothing tells the edge they changed: the origin's
// own cache (lib/cache.js) is invisible to it, so a report stays stale until
// its edge TTL runs out. This module purges the affected URLs as soon as an
// analysis lands.
//
// Inert unless CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID are set, so local
// development and the test suite run without reaching the API. The token needs
// only the Zone → Cache Purge permission on the zone.

const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';

// Cloudflare accepts at most 30 URLs per purge-by-URL call on every plan.
const MAX_URLS_PER_REQUEST = 30;

// A purge failure must never fail the upload it followed, so the call is
// bounded rather than left to the analyser's patience.
const DEFAULT_TIMEOUT_MS = 5000;

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getPurgeConfiguration({
  token = process.env.CLOUDFLARE_API_TOKEN,
  zoneId = process.env.CLOUDFLARE_ZONE_ID,
  apiBase = process.env.CLOUDFLARE_API_BASE
} = {}) {
  const config = {
    token: trimmed(token),
    zoneId: trimmed(zoneId),
    apiBase: trimmed(apiBase).replace(/\/+$/, '') || DEFAULT_API_BASE
  };

  return config.token && config.zoneId ? config : null;
}

function isConfigured(options) {
  return getPurgeConfiguration(options) !== null;
}

/**
 * The URLs a single analysis changes that can be named exactly. The tracker
 * and company pages it also changes cannot be enumerated without the reverse
 * index, and paginated directory URLs would exceed the per-call limit, so
 * those are left to the short s-maxage the pages carry.
 */
function analysisUrls(baseUrl, appId) {
  const base = trimmed(baseUrl).replace(/\/+$/, '');
  if (!base) return [];

  return [
    `${base}/analysis/${encodeURIComponent(appId)}`,
    `${base}/`,
    `${base}/statistics`,
    `${base}/trackers`,
    `${base}/companies`,
    `${base}/sitemap.xml`
  ];
}

function chunk(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size)
    chunks.push(values.slice(i, i + size));

  return chunks;
}

async function purgeBatch(files, config, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(`${config.apiBase}/zones/${config.zoneId}/purge_cache`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ files }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok)
    throw new Error(`Cloudflare purge returned ${response.status}`);

  // Cloudflare answers 200 with success: false for a rejected purge, so the
  // status alone does not say the cache was cleared.
  const body = await response.json();
  if (!body || body.success !== true) {
    const detail = body && Array.isArray(body.errors)
      ? body.errors.map((error) => error && error.message).filter(Boolean).join('; ')
      : '';
    throw new Error(`Cloudflare purge was rejected${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Purge the given absolute URLs from the edge cache. Resolves false when the
 * integration is unconfigured or the purge failed; callers treat that as a
 * slower refresh, not an error.
 */
async function purgeUrls(urls, options = {}) {
  const config = getPurgeConfiguration(options);
  if (!config) return false;

  const files = [...new Set((urls || []).filter(Boolean))];
  if (files.length === 0) return false;

  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  try {
    for (const batch of chunk(files, MAX_URLS_PER_REQUEST))
      await purgeBatch(batch, config, { fetchImpl, timeoutMs });

    return true;
  } catch (err) {
    console.error('Cloudflare purge failed:', err.message);
    return false;
  }
}

function purgeAfterAnalysis(baseUrl, appId, options = {}) {
  return purgeUrls(analysisUrls(baseUrl, appId), options);
}

module.exports = {
  DEFAULT_API_BASE,
  MAX_URLS_PER_REQUEST,
  analysisUrls,
  getPurgeConfiguration,
  isConfigured,
  purgeAfterAnalysis,
  purgeUrls
};
