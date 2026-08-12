// Reverse lookup index: tracker -> apps and company -> apps.
//
// The website's per-app reports answer "what is in this app?". Journalists and
// researchers usually arrive with the opposite question: "which apps contain
// this tracker?". This module builds that inverted view once per analysis
// generation so the lookup pages can be served from a cached structure instead
// of scanning every stored analysis per request.
//
// The index is normalised: app metadata is stored once in `apps`, and tracker
// and company entries reference apps by bundle ID. That keeps the cached JSON
// small enough to read cheaply even when every app appears in several lists.
const jurisdiction = require('./jurisdiction');
const crypto = require('node:crypto');

const MAX_SLUG_LENGTH = 80;
// Allows persisted legacy slugs as well as deterministic hash suffixes.
const MAX_SLUG_LENGTH_WITH_SUFFIX = MAX_SLUG_LENGTH + 8;
const SLUG_HASH_LENGTH = 8;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Build a URL-safe slug for a tracker or company name.
 * Names contain spaces, dots and other punctuation ("Mob.com", "Unity3d Ads"),
 * so the slug is lossy; collisions are resolved when slugs are assigned.
 */
function slugify(name) {
  const slug = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug || 'unnamed';
}

/**
 * Whether a value can be a slug at all. Route handlers check this before
 * touching the index so arbitrary path segments never reach a property lookup.
 */
function isValidSlug(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SLUG_LENGTH_WITH_SUFFIX
    && SLUG_PATTERN.test(value);
}

function reviewCount(details) {
  const raw = details && details.reviews;
  const parsed = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function percentage(count, total) {
  return total > 0 ? (count / total * 100).toFixed(1) : '0.0';
}

function createTrackerEntry(displayName) {
  const resolved = jurisdiction.resolveTrackerName(displayName);
  const company = resolved ? jurisdiction.getUltimateParent(resolved) : null;
  const country = resolved ? jurisdiction.getUltimateCountry(resolved) : null;

  return {
    name: displayName,
    // System APIs are reported by the analyser but are not third-party
    // trackers, and jurisdiction analysis excludes them. Flagging them keeps
    // the directory honest rather than listing them as unattributed trackers.
    system: jurisdiction.isSystemSignature(displayName),
    company: company || null,
    country: company ? country : null,
    countryName: company ? jurisdiction.getCountryName(country) : null,
    flag: company ? jurisdiction.countryFlag(country) : '',
    region: company ? jurisdiction.classifyRegion(country) : 'Unresolved',
    appIds: []
  };
}

function compareNames(a, b) {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Add a deterministic discriminator for a new name that collides with an
 * existing slug. The name is canonicalised because tracker and company maps
 * are case-insensitive, so changing only the display-name casing cannot move
 * a URL.
 */
function collisionSlug(name, base, hashLength = SLUG_HASH_LENGTH) {
  const canonical = String(name == null ? '' : name).toLowerCase().trim();
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  const suffix = hash.slice(0, hashLength);
  const prefixLength = MAX_SLUG_LENGTH - suffix.length - 1;
  const prefix = base.slice(0, prefixLength).replace(/-+$/, '') || 'unnamed';
  return `${prefix}-${suffix}`;
}

/**
 * Assign a unique slug to every entry. Previously assigned slugs win, so a
 * newly discovered name cannot take over a URL that was already published.
 * New collisions use a name-derived hash instead of a positional counter.
 */
function assignSlugs(entries, previousSlugs = {}) {
  const used = new Set();
  const pending = [];

  for (const entry of [...entries].sort((a, b) => compareNames(a.name, b.name))) {
    const key = String(entry.name).toLowerCase().trim();
    const previous = previousSlugs && previousSlugs[key];
    if (isValidSlug(previous) && !used.has(previous)) {
      used.add(previous);
      entry.slug = previous;
    } else {
      pending.push(entry);
    }
  }

  for (const entry of pending) {
    const base = slugify(entry.name);
    let slug = base;
    if (used.has(slug)) {
      let hashLength = SLUG_HASH_LENGTH;
      do {
        slug = collisionSlug(entry.name, base, hashLength);
        hashLength += 8;
      } while (used.has(slug) && hashLength <= 64);
      if (used.has(slug)) {
        throw new Error(`Unable to assign a unique slug for ${entry.name}`);
      }
    }
    used.add(slug);
    entry.slug = slug;
  }
}

/**
 * Build the reverse index from the rows returned by Apps.getAllApps().
 *
 * `totalApps` counts every successfully analysed app, including apps where no
 * tracker was detected, so it matches the denominator used by the aggregate
 * jurisdiction statistics and can be quoted as "N of M apps".
 */
function buildReverseIndex(allApps, previousIndex = null) {
  const apps = {};
  const trackerEntries = new Map(); // lowercased tracker name -> entry
  let totalApps = 0;
  let trackedApps = 0;
  let latestAnalysis = null;

  for (const app of allApps || []) {
    const analysis = app && app.analysis;
    if (!app.appid || !analysis || analysis.success === false) continue;

    totalApps++;

    const analysedAt = app.analysed ? new Date(app.analysed) : null;
    const analysedValid = analysedAt && !Number.isNaN(analysedAt.getTime());
    if (analysedValid && (!latestAnalysis || analysedAt > latestAnalysis))
      latestAnalysis = analysedAt;

    const trackerNames = analysis.trackers ? Object.keys(analysis.trackers) : [];
    const thirdPartyTrackerNames = trackerNames.filter(
      (trackerName) => !jurisdiction.isSystemSignature(trackerName)
    );
    if (thirdPartyTrackerNames.length > 0) trackedApps++;

    const details = app.details || {};
    const analysed = jurisdiction.analyseApp(analysis);

    // Every analysed app enters the directory, including apps with no detected
    // tracker: the lookup pages only reference the tracked ones, but the
    // sitemap covers all of them.
    apps[app.appid] = {
      appid: app.appid,
      title: details.title || app.appid,
      icon: details.icon || null,
      category: details.primaryGenre || null,
      reviews: reviewCount(details),
      trackerCount: thirdPartyTrackerNames.length,
      classification: analysed.classification,
      analysed: analysedValid ? analysedAt.toISOString() : null
    };

    for (const trackerName of trackerNames) {
      const key = String(trackerName).toLowerCase().trim();
      if (!key) continue;

      let entry = trackerEntries.get(key);
      if (!entry) {
        entry = createTrackerEntry(trackerName);
        trackerEntries.set(key, entry);
      }

      // Two tracker names in the same app can normalise to one key; count the
      // app once.
      if (entry.appIds[entry.appIds.length - 1] !== app.appid)
        entry.appIds.push(app.appid);
    }
  }

  // Trackers resolve to a company deterministically, so companies are derived
  // from the tracker entries rather than recomputed from each app.
  const companyEntries = new Map();
  for (const entry of trackerEntries.values()) {
    if (!entry.company) continue;

    const key = entry.company.toLowerCase();
    let company = companyEntries.get(key);
    if (!company) {
      company = {
        name: entry.company,
        country: entry.country,
        countryName: entry.countryName,
        flag: entry.flag,
        region: entry.region,
        trackers: [],
        appIdSet: new Set()
      };
      companyEntries.set(key, company);
    }
    company.trackers.push(entry);
    for (const appid of entry.appIds) company.appIdSet.add(appid);
  }

  const trackerArray = [...trackerEntries.values()];
  const companyArray = [...companyEntries.values()];
  assignSlugs(trackerArray, previousIndex && previousIndex.trackerSlugs);
  assignSlugs(companyArray, previousIndex && previousIndex.companySlugs);

  const companySlugByName = new Map();
  for (const company of companyArray)
    companySlugByName.set(company.name.toLowerCase(), company.slug);

  // Most popular app first: the apps a reader recognises are the ones worth
  // showing on page one.
  const byPopularity = (a, b) =>
    apps[b].reviews - apps[a].reviews
    || compareNames(apps[a].title, apps[b].title)
    || compareNames(a, b);

  const trackers = {};
  for (const entry of trackerArray) {
    entry.appIds.sort(byPopularity);
    trackers[entry.slug] = {
      slug: entry.slug,
      name: entry.name,
      system: entry.system,
      company: entry.company,
      companySlug: entry.company
        ? companySlugByName.get(entry.company.toLowerCase()) || null
        : null,
      country: entry.country,
      countryName: entry.countryName,
      flag: entry.flag,
      region: entry.region,
      appCount: entry.appIds.length,
      pct: percentage(entry.appIds.length, totalApps),
      appIds: entry.appIds
    };
  }

  const companies = {};
  for (const company of companyArray) {
    const appIds = [...company.appIdSet].sort(byPopularity);
    companies[company.slug] = {
      slug: company.slug,
      name: company.name,
      country: company.country,
      countryName: company.countryName,
      flag: company.flag,
      region: company.region,
      appCount: appIds.length,
      pct: percentage(appIds.length, totalApps),
      appIds,
      trackers: company.trackers
        .map((entry) => ({
          name: entry.name,
          slug: entry.slug,
          appCount: entry.appIds.length
        }))
        .sort((a, b) => b.appCount - a.appCount || compareNames(a.name, b.name))
    };
  }

  const byPrevalence = (source) => (a, b) =>
    source[b].appCount - source[a].appCount || compareNames(source[a].name, source[b].name);

  // Name -> slug maps let other pages (app reports, statistics tables) link
  // into the lookup pages without re-deriving a slug that may have been
  // deduplicated here.
  const trackerSlugs = {};
  for (const entry of trackerArray) trackerSlugs[entry.name.toLowerCase().trim()] = entry.slug;
  const companySlugs = {};
  for (const entry of companyArray) companySlugs[entry.name.toLowerCase().trim()] = entry.slug;

  return {
    trackerSlugs,
    companySlugs,
    totalApps,
    trackedApps,
    latestAnalysis: latestAnalysis ? latestAnalysis.toISOString() : null,
    apps,
    trackers,
    trackerList: Object.keys(trackers).sort(byPrevalence(trackers)),
    companies,
    companyList: Object.keys(companies).sort(byPrevalence(companies))
  };
}

/**
 * Look up an entry by slug. Uses an own-property check so that slugs like
 * "constructor" cannot reach inherited properties.
 */
function lookup(collection, slug) {
  if (!collection || !isValidSlug(slug)) return null;
  return Object.prototype.hasOwnProperty.call(collection, slug)
    ? collection[slug]
    : null;
}

function lookupTracker(index, slug) {
  return index ? lookup(index.trackers, slug) : null;
}

function lookupCompany(index, slug) {
  return index ? lookup(index.companies, slug) : null;
}

/**
 * Slug for a tracker or company name, or null when the name does not appear in
 * any analysed app.
 */
function slugForName(slugMap, name) {
  if (!slugMap || !name) return null;
  const key = String(name).toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(slugMap, key) ? slugMap[key] : null;
}

/**
 * Resolve a page of app IDs into app records, dropping any ID that is missing
 * from the directory.
 */
function paginate(appIds, appDirectory, page, perPage) {
  const items = (appIds || []).filter((appid) =>
    appDirectory
      && Object.prototype.hasOwnProperty.call(appDirectory, appid)
      && appDirectory[appid]
  );
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * perPage;

  return {
    page: currentPage,
    totalPages,
    perPage,
    total: items.length,
    from: items.length === 0 ? 0 : start + 1,
    to: Math.min(start + perPage, items.length),
    apps: items
      .slice(start, start + perPage)
      .map((appid) => appDirectory[appid])
      .filter(Boolean)
  };
}

function parsePage(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

module.exports = {
  slugify,
  isValidSlug,
  buildReverseIndex,
  lookupTracker,
  lookupCompany,
  slugForName,
  paginate,
  parsePage
};
