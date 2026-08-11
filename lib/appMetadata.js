'use strict';

function detailsFromStorefront(storefront) {
  if (!storefront) return {};
  return storefront.details || storefront;
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') || null;
}

function buildReportMetadata({ analysis = null, queueSnapshot = null, storefront = null } = {}) {
  const current = detailsFromStorefront(storefront);
  const queued = queueSnapshot || {};
  const analysedVersion = firstNonEmpty(analysis && analysis.analysis_app_version);
  const currentStorefrontVersion = firstNonEmpty(current.version);
  const currentVersion = analysedVersion
    ? (currentStorefrontVersion && currentStorefrontVersion !== analysedVersion
      ? currentStorefrontVersion
      : null)
    : firstNonEmpty(currentStorefrontVersion, queued.version);

  return {
    title: firstNonEmpty(current.title, queued.title),
    icon: firstNonEmpty(current.icon, queued.icon),
    url: firstNonEmpty(current.url, queued.url),
    analysedVersion,
    analysedAt: firstNonEmpty(analysis && analysis.analysed),
    currentVersion,
    currentVersionFromStorefront: Boolean(currentStorefrontVersion),
    queueVersion: firstNonEmpty(queued.version),
    currentFetchedAt: firstNonEmpty(
      storefront && (storefront.fetched_at || storefront.fetchedAt),
      storefront && storefront.current_fetched_at
    )
  };
}

module.exports = { buildReportMetadata };
