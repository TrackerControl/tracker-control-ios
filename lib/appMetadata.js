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

// Fields the listing pages render. The rest of the queue-time snapshot is
// carried through untouched so this stays a refresh rather than a projection.
const LISTING_FIELDS = ['title', 'icon', 'url', 'version', 'primaryGenre', 'reviews'];

/**
 * Display details for the pages that list many apps at once — the homepage,
 * the directories, the lookup pages and the sitemap.
 *
 * apps.details is the snapshot taken when the app was queued and is never
 * updated; the App Store cache row is what the metadata jobs refresh. Listing
 * pages read the snapshot directly, which would leave them showing a title the
 * report page contradicts. Refreshed values therefore win field by field, so a
 * new title is not paired with an icon dropped from a partial response.
 */
function buildListingDetails({ queueSnapshot = null, storefront = null } = {}) {
  const current = detailsFromStorefront(storefront) || {};
  const merged = { ...(queueSnapshot || {}) };

  for (const field of LISTING_FIELDS) {
    // Tested directly rather than through firstNonEmpty, whose `||` maps a
    // numeric 0 to null. An app really can hold zero reviews, and that is a
    // refreshed value like any other.
    const value = current[field];
    if (value !== null && value !== undefined && value !== '')
      merged[field] = value;
  }

  return merged;
}

module.exports = { buildReportMetadata, buildListingDetails };
