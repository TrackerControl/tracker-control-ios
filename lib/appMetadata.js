'use strict';

function detailsFromStorefront(storefront) {
  if (!storefront) return null;
  return storefront.details || null;
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') || null;
}

// storefront is the latest known App Store cache row; analysisStorefront is
// the snapshot preserved with the currently displayed analysis (migration
// 013). When the current cache row is missing entirely (e.g. pruned, or the
// app was never re-cached after analysis), the analysis-time snapshot is a
// better fallback for title/icon/url than the queue-time snapshot, since it
// reflects the app as it looked when analysed rather than when queued.
function buildReportMetadata({
  analysis = null,
  queueSnapshot = null,
  storefront = null,
  analysisStorefront = null
} = {}) {
  const current = detailsFromStorefront(storefront) || {};
  const historical = detailsFromStorefront(analysisStorefront) || {};
  const queued = queueSnapshot || {};
  const analysedVersion = firstNonEmpty(analysis && analysis.analysis_app_version);
  const currentStorefrontVersion = firstNonEmpty(current.version);
  const currentVersion = analysedVersion
    ? (currentStorefrontVersion && currentStorefrontVersion !== analysedVersion
      ? currentStorefrontVersion
      : null)
    : firstNonEmpty(currentStorefrontVersion, queued.version);

  return {
    title: firstNonEmpty(current.title, historical.title, queued.title),
    icon: firstNonEmpty(current.icon, historical.icon, queued.icon),
    url: firstNonEmpty(current.url, historical.url, queued.url),
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
