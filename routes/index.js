const express = require('express');
const { check, validationResult } = require('express-validator');
const fs = require('fs');
const store = require('../lib/appStore');
const Apps = require('../models/Apps');
const jurisdiction = require('../lib/jurisdiction');
const cache = require('../lib/cache');
const reverseIndex = require('../lib/reverseIndex');
const { isValidAppId } = require('../lib/appId');
const { classifyAnalysisFailure } = require('../lib/analysisFailure');
const asyncHandler = require('../lib/asyncHandler');
const { buildReportMetadata, buildListingDetails } = require('../lib/appMetadata');
const { siteBaseUrl } = require('../lib/siteUrl');

// Taken from https://reports.exodus-privacy.eu.org/api/trackers
const exodusTrackers = JSON.parse(fs.readFileSync('./exodusTrackers.json', 'utf-8'))
const trackerNameToExodus = {};
for (const [key, value] of Object.entries(exodusTrackers.trackers))
  trackerNameToExodus[value.name] = value;

const router = express.Router();
const COUNTRY = 'gb';

const SITE_NAME = 'TrackerControl for iOS';
const DEFAULT_DESCRIPTION = 'Find out which trackers are embedded in iOS apps, '
  + 'which companies control them, and under which jurisdiction that tracking falls.';
const APPS_PER_PAGE = 50;
const MAX_SITEMAP_URLS = 50000;
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

let lastPing = 0; // unix timestamp

function requireValidAppId(req, res, next) {
  if (!isValidAppId(req.params.appId))
    return res.status(400).send('Please provide a valid App Store bundle ID.');

  return next();
}

function renderAnalysisRequest(res, appId, { status = 200, error = null } = {}) {
  res.set('X-Robots-Tag', 'noindex');
  return res.status(status).render('request-analysis', {
    title: 'Request app analysis',
    appId,
    error,
  });
}

// ping from analyser in past hour?
router.use(function (req, res, next) {
  res.locals.analyserOnline = lastPing > Date.now() - 1000*60*60;
  next();
});

function thirdPartyTrackerNames(analysis) {
  return analysis && analysis.trackers
    ? Object.keys(analysis.trackers).filter(
      (trackerName) => !jurisdiction.isSystemSignature(trackerName)
    )
    : [];
}

// Social card and canonical link defaults. Individual routes override these
// with page-specific values by passing them to res.render.
router.use(function (req, res, next) {
  const base = siteBaseUrl(req);
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;

  res.locals.siteName = SITE_NAME;
  res.locals.siteBaseUrl = base;
  res.locals.canonicalUrl = base + path;
  res.locals.pageDescription = DEFAULT_DESCRIPTION;
  res.locals.ogImage = null;
  next();
});

/**
 * Build all homepage + statistics data from DB.
 * Returns { homepage, statistics, appCount }.
 */
function buildSiteData(allApps) {
  // Filter to successfully analysed apps with trackers
  const analysedApps = allApps.filter(a =>
    a.analysis && a.analysis.success !== false && a.analysis.trackers
  );
  const appCount = analysedApps.length;

  // Jurisdiction stats
  const jurisdictionStats = jurisdiction.computeAggregateStats(allApps);

  // Top trackers enriched with company/country
  const trackerCounts = {};
  for (const app of analysedApps) {
    for (const tracker of thirdPartyTrackerNames(app.analysis)) {
      if (!trackerCounts[tracker]) trackerCounts[tracker] = 0;
      trackerCounts[tracker]++;
    }
  }

  const topTrackersEnriched = Object.entries(trackerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => {
      const resolved = jurisdiction.resolveTrackerName(name);
      const parentName = resolved ? jurisdiction.getUltimateParent(resolved) : null;
      const country = resolved ? jurisdiction.getUltimateCountry(resolved) : null;
      return {
        name,
        count,
        pct: appCount > 0 ? (count / appCount * 100).toFixed(1) : '0',
        company: parentName || name,
        country: country,
        countryName: jurisdiction.getCountryName(country),
        flag: jurisdiction.countryFlag(country),
        region: jurisdiction.classifyRegion(country)
      };
    });

  // Apps with the most trackers (for homepage)
  const appsWithMostTrackers = analysedApps
    .filter(a => a.details && a.details.title)
    .map(a => {
      const trackerCount = thirdPartyTrackerNames(a.analysis).length;
      const jd = jurisdiction.analyseApp(a.analysis);
      const topCountries = Object.entries(jd.countryBreakdown || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([code, count]) => ({
          flag: jurisdiction.countryFlag(code),
          pct: Math.round(count / (jd.resolvedCount || 1) * 100)
        }));
      return {
        appid: a.appid,
        title: a.details.title,
        icon: a.details.icon,
        trackerCount,
        classification: jd.classification,
        meta: jurisdiction.classificationMeta[jd.classification],
        topCountries,
        resolvedCount: jd.resolvedCount || 0,
        analysed: a.analysed || null
      };
    })
    .sort((a, b) => b.trackerCount - a.trackerCount)
    .slice(0, 10);

  // Headline numbers for jumbotron — use jurisdictionStats.totalApps as denominator
  // so the percentage matches the bar chart (all analysed apps, incl. those with no trackers)
  const usOnlyCount = jurisdictionStats.classificationCounts.us_only || 0;
  const usOnlyPct = jurisdictionStats.classificationPcts.us_only || '0';

  const latestAnalysis = analysedApps.reduce((latest, a) => {
    if (!a.analysed) return latest;
    return (!latest || a.analysed > latest) ? a.analysed : latest;
  }, null);

  return {
    appCount,
    headlines: {
      totalApps: jurisdictionStats.totalApps,
      usOnlyPct,
      usOnlyCount,
      noTrackersPct: jurisdictionStats.classificationPcts.no_tracking || '0',
      latestAnalysis
    },
    appsWithMostTrackers,
    jurisdictionStats,
    topTrackersEnriched
  };
}

/**
 * Whether cached data was built from the same generation of stored analyses
 * and App Store metadata as the database currently holds.
 */
function signatureMatches(meta, signature) {
  return Boolean(meta)
    && meta.appCount === signature.appCount
    && meta.latestAnalysis === signature.latestAnalysis
    && meta.latestStorefront === signature.latestStorefront;
}

// The signature is an aggregate over every stored app, and each cached view
// asks for it before serving: the report page needs the reverse index for its
// tracker links, and /statistics reads both cached views. Without this it
// would run twice per statistics request and once per report view. A few
// seconds of staleness only delays a rebuild that a background metadata job
// triggered; writes from this process clear the memo outright.
const SIGNATURE_TTL_MS = 5000;
let signatureMemo = null; // { at, signature }

async function getSiteDataSignature() {
  if (signatureMemo && Date.now() - signatureMemo.at < SIGNATURE_TTL_MS)
    return signatureMemo.signature;

  const signature = await Apps.getSiteDataSignature();
  signatureMemo = { at: Date.now(), signature };
  return signature;
}

/**
 * Get site data: serve from cache if app count hasn't changed, otherwise rebuild.
 * Falls back to stale cache on any DB error.
 */
async function getSiteData() {
  const cached = cache.read('sitedata');

  try {
    const signature = await getSiteDataSignature();
    if (cached && signatureMatches(cached.meta, signature)) {
      return cached.data;
    }

    const allApps = await getAllAppsForSignature(signature);
    const data = buildSiteData(allApps);
    if (data.appCount > 0) {
      cache.write('sitedata', data, signature);
      console.log('Site data cache rebuilt for', data.appCount, 'apps');
    }
    return data;
  } catch (err) {
    console.error('DB error in getSiteData:', err.message);
    if (cached) return cached.data;
    throw err;
  }
}

// The reverse index is large compared with the aggregate site data, so it is
// kept in its own cache entry and only touched by the lookup pages and the
// sitemap. The in-process copy avoids re-parsing the cache file per request.
let reverseIndexMemo = null; // { meta, index }
let allAppsMemo = null; // { meta, apps }

async function getAllAppsForSignature(signature) {
  if (allAppsMemo && signatureMatches(allAppsMemo.meta, signature))
    return allAppsMemo.apps;

  // Resolve the display metadata once here so that buildSiteData and
  // buildReverseIndex both see the refreshed title and icon under `details`,
  // rather than each reaching into the storefront columns themselves.
  const apps = (await Apps.getAllApps()).map((row) => ({
    ...row,
    details: buildListingDetails({
      queueSnapshot: row.details,
      storefront: { details: row.current_storefront_details }
    })
  }));
  allAppsMemo = { meta: signature, apps };
  return apps;
}

/**
 * Get the tracker/company reverse index, rebuilding it when new analyses have
 * landed. Falls back to the last known index if the database is unavailable.
 */
async function getReverseIndex() {
  try {
    const signature = await getSiteDataSignature();

    if (reverseIndexMemo && signatureMatches(reverseIndexMemo.meta, signature))
      return reverseIndexMemo.index;

    const cached = cache.read('reverseindex');
    if (cached && signatureMatches(cached.meta, signature)) {
      reverseIndexMemo = { meta: cached.meta, index: cached.data };
      return cached.data;
    }

    const allApps = await getAllAppsForSignature(signature);
    const index = reverseIndex.buildReverseIndex(allApps, cached && cached.data);
    if (index.totalApps > 0) {
      cache.write('reverseindex', index, signature);
      reverseIndexMemo = { meta: signature, index };
      console.log('Reverse index rebuilt for', index.totalApps, 'apps');
    }
    return index;
  } catch (err) {
    console.error('DB error in getReverseIndex:', err.message);
    if (reverseIndexMemo) return reverseIndexMemo.index;
    const cached = cache.read('reverseindex');
    if (cached) return cached.data;
    throw err;
  }
}

function invalidateSiteCaches() {
  cache.invalidate('sitedata');
  cache.invalidate('reverseindex');
  reverseIndexMemo = null;
  allAppsMemo = null;
  signatureMemo = null;
}

const EMPTY_REVERSE_INDEX = {
  trackerSlugs: {},
  companySlugs: {},
  totalApps: 0,
  trackedApps: 0,
  latestAnalysis: null,
  apps: {},
  trackers: {},
  trackerList: [],
  companies: {},
  companyList: []
};

router.get('/', asyncHandler(async (req, res) => {
  try {
    const data = await getSiteData();
    return res.render('form', {
      title: 'App Privacy Checker',
      data: req.body,
      pageDescription: `Search ${data.headlines.totalApps} analysed iOS apps to see `
        + 'which trackers they embed, which companies control them, and under '
        + 'which jurisdiction that tracking falls.',
      headlines: data.headlines,
      appsWithMostTrackers: data.appsWithMostTrackers,
      jurisdictionStats: data.jurisdictionStats,
      jurisdictionMeta: jurisdiction.classificationMeta
    });
  } catch (err) {
    console.error('Homepage error:', err.message);
    return res.render('form', {
      title: 'App Privacy Checker',
      data: req.body,
      headlines: null,
      appsWithMostTrackers: [],
      jurisdictionStats: null,
      jurisdictionMeta: jurisdiction.classificationMeta
    });
  }
}));

/**
 * Attach reverse-lookup slugs to the statistics tables so every tracker and
 * company in them links to the apps it was found in.
 */
function withLookupSlugs(data, index) {
  const trackerSlugs = index.trackerSlugs || {};
  const companySlugs = index.companySlugs || {};
  const trackers = (data.topTrackersEnriched || []).map((tracker) => ({
    ...tracker,
    slug: reverseIndex.slugForName(trackerSlugs, tracker.name),
    companySlug: reverseIndex.slugForName(companySlugs, tracker.company)
  }));
  const companies = (data.jurisdictionStats && data.jurisdictionStats.topCompaniesSorted || [])
    .map((company) => ({
      ...company,
      slug: reverseIndex.slugForName(companySlugs, company.name)
    }));

  return {
    topTrackersEnriched: trackers,
    jurisdictionStats: { ...data.jurisdictionStats, topCompaniesSorted: companies }
  };
}

// Statistics detail page
router.get('/statistics', asyncHandler(async (req, res) => {
  let data;
  try {
    data = await getSiteData();
  } catch (err) {
    console.error('Statistics error:', err.message);
    return res.render('statistics', {
      title: 'Detailed Statistics',
      data: req.body,
      headlines: { totalApps: 0 },
      jurisdictionStats: { totalApps: 0, classificationCounts: {}, classificationPcts: {}, topCompaniesSorted: [], categoriesSorted: [] },
      jurisdictionMeta: jurisdiction.classificationMeta,
      topTrackersEnriched: [],
      europeanAlternatives: jurisdiction.europeanAlternatives,
      xrayCompanyCount: jurisdiction.xrayCompanyCount
    });
  }

  let index = EMPTY_REVERSE_INDEX;
  try {
    index = await getReverseIndex();
  } catch (err) {
    console.error('Statistics lookup data unavailable:', err.message);
  }
  const linked = withLookupSlugs(data, index);

  return res.render('statistics', {
    title: 'Detailed Statistics',
    data: req.body,
    pageDescription: `Tracking jurisdiction across ${data.headlines.totalApps} `
      + 'analysed iOS apps: the most prevalent trackers, the companies behind '
      + 'them, and how they break down by country and App Store category.',
    headlines: data.headlines,
    jurisdictionStats: linked.jurisdictionStats,
    jurisdictionMeta: jurisdiction.classificationMeta,
    topTrackersEnriched: linked.topTrackersEnriched,
    europeanAlternatives: jurisdiction.europeanAlternatives,
    xrayCompanyCount: jurisdiction.xrayCompanyCount
  });
}));

router.get('/healthz', asyncHandler(async (req, res) => {
  try {
    await Apps.healthCheck();
    res.json({ ok: true });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({ ok: false });
  }
}));

router.get('/healthz/analyser', (req, res) => {
  const online = lastPing > Date.now() - 1000*60*60;
  res.status(online ? 200 : 503).json({ ok: online });
});

// Searching is a GET so that a Cloudflare Managed Challenge on this path can
// render its interstitial and replay the request afterwards. Challenges cannot
// do that for a POST body, and pre-clearance covers the analysis request POST.
router.get('/search',
  [
    check('search')
      .isLength({ min: 1 })
      .withMessage('Please enter a search term'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);

    if (errors.isEmpty()) {
      try {
        const result = await store.search({
          term: req.query.search,
          num: 5,
          country : COUNTRY,
        });
        await Apps.cacheAppStoreResults(result);
        const existingApps = await Promise.all(result.map((app) =>
          app.free ? Apps.findApp(app.appId) : null
        ));
        const searchResults = result.map((app, index) => ({
          ...app,
          inDatabase: Boolean(existingApps[index]),
        }));

        res.render('form', {
          title: 'Search app',
          errors: errors.array(),
          data: req.query,
          searchResults
        });
      } catch (err) {
        console.log(err);
        res.send("Error while searching. Try again later.")
      }
    } else {
      res.render('form', {
        title: 'Search app',
        errors: errors.array(),
        data: req.query,
      });
    };
}));

// The confirmation page for an app nobody has requested yet lives on its own
// path so a Cloudflare Managed Challenge rule can cover it without challenging
// every published report. Passing that challenge clears the visitor for the
// POST below, which a challenge could not replay.
router.get('/request/:appId', requireValidAppId, asyncHandler(async (req, res) => {
  const appId = req.params.appId;
  const existing = await Apps.findApp(appId);
  if (existing) return res.redirect(303, `/analysis/${existing.appid}`);

  return renderAnalysisRequest(res, appId);
}));

router.get('/analysis/:appId', requireValidAppId, asyncHandler(async (req, res) => {
  let appId = req.params.appId;

  console.log('Fetching', appId);

  let app = await Apps.findApp(appId);
  if (!app) return res.redirect(303, `/request/${appId}`);

  app.reportMetadata = buildReportMetadata({
    analysis: {
      analysis_app_version: app.analysis_app_version,
      analysed: app.analysed
    },
    queueSnapshot: app.details,
    storefront: {
      details: app.current_storefront_details,
      fetched_at: app.current_fetched_at
    },
    analysisStorefront: {
      details: app.analysis_storefront_details,
      fetched_at: app.analysis_storefront_fetched_at
    }
  });

  if (app.analysis) {
    const analysis = app.analysis;

    if (analysis.success !== undefined && analysis.success === false)
      app.analysisFailure = analysis.reason === 'app_not_found' ? "App not found on App Store." : "Analysis failed."
    else {
      if (analysis.trackers) {
        const trackerNames = thirdPartyTrackerNames(analysis);
        app.trackers = trackerNames.length > 0
          ? "Found trackers: " + trackerNames.join(", ")
          : "No trackers found.";
      }
      else
        app.trackers = "No trackers found."

      if (analysis.permissions)
        app.permissions = "Can request permissions: " + analysis.permissions.join(", ");
      else
        app.permissions = "No permissions can be requested by app."
    }
  } else
    app.queueCount = await Apps.countQueue(app.added);

  // Compute jurisdiction analysis if trackers exist
  let jurisdictionData = null;
  if (app.analysis && app.analysis.trackers && app.analysis.success !== false) {
    jurisdictionData = jurisdiction.analyseApp(app.analysis);
    jurisdictionData.meta = jurisdiction.classificationMeta[jurisdictionData.classification];
    jurisdictionData.sovereigntyNote = jurisdiction.sovereigntyNotes[jurisdictionData.classification];
  }

  // Slugs let each detected tracker and company link through to the other apps
  // that share it.
  let trackerSlugs = {};
  let companySlugs = {};
  try {
    const index = await getReverseIndex();
    trackerSlugs = index.trackerSlugs || {};
    companySlugs = index.companySlugs || {};
  } catch (err) {
    console.error('Tracker links unavailable:', err.message);
  }

  const trackerCount = app.analysis && app.analysis.trackers && app.analysis.success !== false
    ? thirdPartyTrackerNames(app.analysis).length
    : null;
  const systemTrackerNames = app.analysis && app.analysis.trackers && app.analysis.success !== false
    ? Object.keys(app.analysis.trackers).filter((trackerName) =>
      jurisdiction.isSystemSignature(trackerName)
    )
    : [];
  // Social metadata follows the same title/icon precedence as the report body,
  // so a refreshed storefront title is not contradicted by the card.
  const displayTitle = app.reportMetadata.title || app.details.title;
  const pageDescription = trackerCount === null
    ? `Tracker analysis of ${displayTitle} for iOS.`
    : `${trackerCount === 0 ? 'No trackers were' : `${trackerCount} tracker${trackerCount === 1 ? ' was' : 's were'}`}`
      + ` detected in ${displayTitle} for iOS`
      + (jurisdictionData && jurisdictionData.meta ? `: ${jurisdictionData.meta.label.toLowerCase()}.` : '.');

  res.render('form', {
    title: displayTitle,
    data: req.body,
    app: app,
    trackerNameToExodus: trackerNameToExodus,
    trackerSlugs: trackerSlugs,
    companySlugs: companySlugs,
    jurisdictionData: jurisdictionData,
    trackerCount,
    systemTrackerNames,
    pageDescription,
    ogImage: app.reportMetadata.icon || app.details.icon || null
  });
}));

router.post('/analysis/:appId',
  requireValidAppId,
  asyncHandler(async (req, res) => {
    const requestedAppId = req.params.appId;
    const existing = await Apps.findApp(requestedAppId);
    if (existing)
      return res.redirect(303, `/analysis/${existing.appid}`);

    let details = await Apps.findCachedAppStoreResult(requestedAppId);
    let fetchedFromAppStore = false;
    if (!details) {
      try {
        details = await store.app({ appId: requestedAppId, country: COUNTRY });
        fetchedFromAppStore = true;
      } catch (err) {
        console.log(err);

        if (String(err).includes('App not found (404)')) {
          return renderAnalysisRequest(res, requestedAppId, {
            status: 404,
            error: 'App not found on App Store.',
          });
        }
        return renderAnalysisRequest(res, requestedAppId, {
          status: 502,
          error: 'Downloading of app information failed. Please try again later.',
        });
      }
    }

    if (!details.free) {
      if (fetchedFromAppStore) {
        try {
          await Apps.cacheAppStoreResults([details]);
        } catch (err) {
          console.log(err);
          return renderAnalysisRequest(res, requestedAppId, {
            status: 500,
            error: 'Error storing app information. Please try again later.',
          });
        }
      }
      return renderAnalysisRequest(res, requestedAppId, {
        status: 400,
        error: 'Can\'t analyse non-free apps.',
      });
    }

    try {
      if (fetchedFromAppStore) {
        await Apps.addAppAndStorefront(requestedAppId, details);
      } else {
        await Apps.addApp(requestedAppId, details);
      }
    } catch (err) {
      console.log(err);
      return renderAnalysisRequest(res, requestedAppId, {
        status: 500,
        error: 'Error adding app. Please try again later.',
      });
    }

    return res.redirect(303, `/analysis/${details.appId}`);
  }));

// About page: what this service does, what a report does and does not mean,
// where the country labels come from, and who is behind it.
router.get('/about', (req, res) => {
  res.render('about', {
    title: 'About',
    pageDescription: 'How this service analyses iOS apps for embedded trackers, '
      + 'what a report does and does not tell you, who runs it, and how to get '
      + 'in touch.',
    jurisdictionMeta: jurisdiction.classificationMeta
  });
});

/**
 * Render a directory of every tracker or company seen in an analysed app.
 */
function renderDirectory(kind) {
  return asyncHandler(async (req, res) => {
    let index;
    try {
      index = await getReverseIndex();
    } catch (err) {
      console.error('Directory error:', err.message);
      index = EMPTY_REVERSE_INDEX;
    }

    const isTracker = kind === 'tracker';
    const entries = isTracker
      ? index.trackerList.map((slug) => index.trackers[slug])
      : index.companyList.map((slug) => index.companies[slug]);

    res.render('directory', {
      title: isTracker ? 'Tracker directory' : 'Company directory',
      kind,
      entries,
      totalApps: index.totalApps,
      trackedApps: index.trackedApps,
      latestAnalysis: index.latestAnalysis,
      pageDescription: isTracker
        ? `Every tracker detected across ${index.totalApps} analysed iOS apps, `
          + 'with the company and country behind it.'
        : `Every company whose tracking code was detected across ${index.totalApps} `
          + 'analysed iOS apps, ranked by how many apps they reach.'
    });
  });
}

router.get('/trackers', renderDirectory('tracker'));
router.get('/companies', renderDirectory('company'));

/**
 * Reverse lookup: the apps in which a given tracker, or any tracker belonging
 * to a given company, was detected.
 */
function renderLookup(kind) {
  return asyncHandler(async (req, res) => {
    const isTracker = kind === 'tracker';
    let index;
    try {
      index = await getReverseIndex();
    } catch (err) {
      console.error('Lookup error:', err.message);
      return res.status(503).send('Lookup data is temporarily unavailable. Please try again later.');
    }

    const entry = isTracker
      ? reverseIndex.lookupTracker(index, req.params.slug)
      : reverseIndex.lookupCompany(index, req.params.slug);

    if (!entry) {
      return res.status(404).send(isTracker
        ? 'Unknown tracker. See /trackers for the full list.'
        : 'Unknown company. See /companies for the full list.');
    }

    const pagination = reverseIndex.paginate(
      entry.appIds,
      index.apps,
      reverseIndex.parsePage(req.query.page),
      APPS_PER_PAGE
    );

    const attribution = entry.company || (isTracker ? null : entry.name);
    const description = `${entry.name} was detected in ${entry.appCount} of `
      + `${index.totalApps} analysed iOS apps (${entry.pct}%)`
      + (attribution && entry.countryName ? `. Operated by ${attribution} (${entry.countryName}).` : '.');

    res.render('lookup', {
      title: entry.name,
      kind,
      entry,
      pagination,
      totalApps: index.totalApps,
      latestAnalysis: index.latestAnalysis,
      jurisdictionMeta: jurisdiction.classificationMeta,
      exodus: isTracker ? trackerNameToExodus[entry.name] : null,
      companySlug: isTracker ? entry.companySlug : null,
      pageDescription: description,
      canonicalUrl: res.locals.canonicalUrl
        + (pagination.page > 1 ? `?page=${pagination.page}` : '')
    });
  });
}

router.get('/tracker/:slug', renderLookup('tracker'));
router.get('/company/:slug', renderLookup('company'));

// serve next task to analyser
router.get('/queue', asyncHandler(async (req, res) => {
  const requestedAppId = req.query.appId || null;
  if (requestedAppId && !isValidAppId(requestedAppId))
    return res.status(400).send('Please provide a valid App Store bundle ID.');

  let app = await Apps.nextApp(requestedAppId);
  console.log(app ? app.appid : null);

  if (!app)
    return res.send();

  // Keep the body as the bundle ID for deployed analysers while newer
  // clients carry the per-assignment token in a separate header.
  res.set('X-Analysis-Claim-Token', app.analysis_claim_token);
  res.send(app.appid);
}));

// enable analyser to report online status
router.get('/ping', (req, res) => {
    lastPing = Date.now();

    res.send("online");
});

// upload analysis results
router.post('/uploadAnalysis', asyncHandler(async (req, res) => {
  if (!req.query.appId || !req.query.analysisVersion)
    return res.status(400).send('Please provide appId and analysisVersion');
  const appId = req.query.appId;
  const analysisVersion = req.query.analysisVersion;

  if (!isValidAppId(appId))
    return res.status(400).send('Please provide a valid App Store bundle ID.');

  const claimToken = req.get('X-Analysis-Claim-Token');
  if (!Apps.isValidAnalysisClaimToken(claimToken))
    return res.status(400).send('Please provide a valid analysis claim token.');

  console.log('Updating', appId);

  if (!req.body)
    return res.status(400).end("Please provide valid JSON");
  const analysis = req.body;

  const result = await Apps.updateAnalysis(appId, analysis, analysisVersion, claimToken);
  if (result.rowCount === 0)
    return res.status(409).send('Analysis claim is no longer active.');

  invalidateSiteCaches();
  res.json({ ok: true });
}));

// avoid a loop: only analyse each app once
router.post('/reportAnalysisFailure', asyncHandler(async (req, res) => {
  if (!req.query.appId || !req.query.analysisVersion)
    return res.status(400).send('Please provide appId and analysisVersion');

  if (!isValidAppId(req.query.appId))
    return res.status(400).send('Please provide a valid App Store bundle ID.');

  const claimToken = req.get('X-Analysis-Claim-Token');
  if (!Apps.isValidAnalysisClaimToken(claimToken))
    return res.status(400).send('Please provide a valid analysis claim token.');

  const logs = req.body; // should contain the log
  const failure = classifyAnalysisFailure(logs);
  console.log('Removing from queue', req.query.appId, logs);

  const result = await Apps.updateAnalysis(req.query.appId, {
    success: false,
    logs: logs,
    reason: failure.reason,
    retryable: failure.retryable
  }, req.query.analysisVersion, claimToken);
  if (result.rowCount === 0)
    return res.status(409).send('Analysis claim is no longer active.');

  invalidateSiteCaches();
  res.json({ ok: true });
}));

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sitemapEntry(base, path, { lastmod, changefreq, priority } = {}) {
  const parts = [`    <loc>${escapeXml(base + path)}</loc>`];
  if (lastmod) parts.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`);
  if (changefreq) parts.push(`    <changefreq>${changefreq}</changefreq>`);
  if (priority) parts.push(`    <priority>${priority}</priority>`);
  return `  <url>\n${parts.join('\n')}\n  </url>`;
}

function renderSitemap(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>`;
}

function renderSitemapIndex(base, pageCount) {
  const entries = Array.from({ length: pageCount }, (_, index) =>
    `  <sitemap>\n    <loc>${escapeXml(base + `/sitemap-${index + 1}.xml`)}</loc>\n  </sitemap>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</sitemapindex>`;
}

function splitSitemapEntries(entries) {
  const pages = [];
  let page = [];
  const emptyPageBytes = Buffer.byteLength(renderSitemap([]), 'utf8');
  let pageBytes = emptyPageBytes;

  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(entry, 'utf8');
    const candidateBytes = pageBytes + (page.length > 0 ? 1 : 0) + entryBytes;
    const tooManyUrls = page.length + 1 > MAX_SITEMAP_URLS;
    const tooLarge = candidateBytes > MAX_SITEMAP_BYTES;
    if (page.length > 0 && (tooManyUrls || tooLarge)) {
      pages.push(page);
      page = [entry];
      pageBytes = emptyPageBytes + entryBytes;
    } else {
      page.push(entry);
      pageBytes = candidateBytes;
    }
  }

  if (page.length > 0) pages.push(page);
  return pages;
}

function sitemapEntries(base, index) {
  const updated = index.latestAnalysis;
  const entries = [
    sitemapEntry(base, '/', { lastmod: updated, changefreq: 'daily', priority: '1.0' }),
    sitemapEntry(base, '/statistics', { lastmod: updated, changefreq: 'daily', priority: '0.9' }),
    sitemapEntry(base, '/trackers', { lastmod: updated, changefreq: 'daily', priority: '0.9' }),
    sitemapEntry(base, '/companies', { lastmod: updated, changefreq: 'daily', priority: '0.8' }),
    sitemapEntry(base, '/about', { changefreq: 'monthly', priority: '0.7' })
  ];

  for (const slug of index.trackerList)
    entries.push(sitemapEntry(base, `/tracker/${slug}`, { lastmod: updated, changefreq: 'weekly', priority: '0.7' }));

  for (const slug of index.companyList)
    entries.push(sitemapEntry(base, `/company/${slug}`, { lastmod: updated, changefreq: 'weekly', priority: '0.6' }));

  for (const app of Object.values(index.apps))
    entries.push(sitemapEntry(base, `/analysis/${app.appid}`, {
      lastmod: app.analysed,
      changefreq: 'monthly',
      priority: '0.6'
    }));

  return entries;
}

async function getSitemapPages(base) {
  let index;
  try {
    index = await getReverseIndex();
  } catch (err) {
    console.error('Sitemap error:', err.message);
    index = EMPTY_REVERSE_INDEX;
  }
  return splitSitemapEntries(sitemapEntries(base, index));
}

// Sitemap over the report, lookup and reference pages. Built from the cached
// reverse index so a crawl does not read every stored analysis from the
// database.
router.get('/sitemap.xml', asyncHandler(async (req, res) => {
  const base = siteBaseUrl(req);
  const pages = await getSitemapPages(base);

  res.type('application/xml').send(pages.length === 1
    ? renderSitemap(pages[0])
    : renderSitemapIndex(base, pages.length));
}));

router.get('/sitemap-:page.xml', asyncHandler(async (req, res) => {
  const pageNumber = Number(req.params.page);
  if (!Number.isInteger(pageNumber) || pageNumber < 1)
    return res.status(404).send('Sitemap not found.');

  const base = siteBaseUrl(req);
  const pages = await getSitemapPages(base);
  if (pageNumber > pages.length)
    return res.status(404).send('Sitemap not found.');

  res.type('application/xml').send(renderSitemap(pages[pageNumber - 1]));
}));

// /search and /request/ are GETs, so unlike a form post they are reachable by
// a crawler that finds the URL. Both spend an App Store call and both sit
// behind a Cloudflare Managed Challenge, so a crawl of them would burn quota
// and collect interstitials rather than content.
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /search',
    'Disallow: /request/',
    'Disallow: /queue',
    'Disallow: /ping',
    'Disallow: /healthz',
    '',
    `Sitemap: ${siteBaseUrl(req)}/sitemap.xml`,
    ''
  ].join('\n'));
});

module.exports = router; // make accessible to /app.js
