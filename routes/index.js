const express = require('express');
const { check, validationResult } = require('express-validator');
const fs = require('fs');
const store = require('../lib/appStore');
const Apps = require('../models/Apps');
const jurisdiction = require('../lib/jurisdiction');
const cache = require('../lib/cache');
const { isValidAppId } = require('../lib/appId');
const { classifyAnalysisFailure } = require('../lib/analysisFailure');
const asyncHandler = require('../lib/asyncHandler');
const turnstile = require('../lib/turnstile');
const { buildReportMetadata } = require('../lib/appMetadata');

// Taken from https://reports.exodus-privacy.eu.org/api/trackers
const exodusTrackers = JSON.parse(fs.readFileSync('./exodusTrackers.json', 'utf-8'))
const trackerNameToExodus = {};
for (const [key, value] of Object.entries(exodusTrackers.trackers))
  trackerNameToExodus[value.name] = value;

const router = express.Router();
const COUNTRY = 'gb';

let lastPing = 0; // unix timestamp

function requireTurnstile(expectedAction) {
  return asyncHandler(async (req, res, next) => {
    const configurationError = turnstile.getTurnstileConfigurationError();
    if (configurationError) {
      console.error(`Turnstile configuration error: ${configurationError}`);
      return renderTurnstileFailure(req, res, expectedAction, {
        status: 503,
        error: 'Security verification is temporarily unavailable. Please try again later.',
      });
    }

    const token = req.body && req.body['cf-turnstile-response'];
    if (typeof token !== 'string' || token.length === 0) {
      // Reaching the endpoint without a token means the visitor has not been
      // through the confirmation page yet, which is not a failure worth an
      // error message — just show them that page.
      return renderTurnstileFailure(req, res, expectedAction, { status: 200 });
    }

    const valid = await turnstile.validateTurnstile({
      token,
      remoteIp: req.ip,
      expectedAction,
    });
    if (!valid) {
      console.warn(`Turnstile token validation failed for action: ${expectedAction}`);
      return renderTurnstileFailure(req, res, expectedAction, {
        status: 403,
        error: 'The security check expired or failed. Please try again.',
      });
    }

    return next();
  });
}

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

function renderTurnstileFailure(req, res, expectedAction, { status, error = null }) {
  return renderAnalysisRequest(res, req.params.appId, { status, error });
}

// ping from analyser in past hour?
router.use(function (req, res, next) {
  res.locals.analyserOnline = lastPing > Date.now() - 1000*60*60;
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
    for (const tracker of Object.keys(app.analysis.trackers)) {
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
      const trackerCount = Object.keys(a.analysis.trackers).length;
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
 * Get site data: serve from cache if app count hasn't changed, otherwise rebuild.
 * Falls back to stale cache on any DB error.
 */
async function getSiteData() {
  const cached = cache.read('sitedata');

  try {
    const signature = await Apps.getSiteDataSignature();
    if (cached
      && cached.meta
      && cached.meta.appCount === signature.appCount
      && cached.meta.latestAnalysis === signature.latestAnalysis) {
      return cached.data;
    }

    const allApps = await Apps.getAllApps();
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

router.get('/', asyncHandler(async (req, res) => {
  try {
    const data = await getSiteData();
    return res.render('form', {
      title: 'App Privacy Checker',
      data: req.body,
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

// Statistics detail page
router.get('/statistics', asyncHandler(async (req, res) => {
  try {
    const data = await getSiteData();
    return res.render('statistics', {
      title: 'Detailed Statistics',
      data: req.body,
      headlines: data.headlines,
      jurisdictionStats: data.jurisdictionStats,
      jurisdictionMeta: jurisdiction.classificationMeta,
      topTrackersEnriched: data.topTrackersEnriched,
      europeanAlternatives: jurisdiction.europeanAlternatives,
      xrayCompanyCount: jurisdiction.xrayCompanyCount
    });
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

router.get('/analysis/:appId', requireValidAppId, asyncHandler(async (req, res) => {
  let appId = req.params.appId;

  console.log('Fetching', appId);

  let app = await Apps.findApp(appId);
  if (!app) return renderAnalysisRequest(res, appId);

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
      if (analysis.trackers)
        app.trackers = "Found trackers: " + Object.keys(analysis.trackers).join(", ");
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

  res.render('form', {
    title: app.reportMetadata.title || app.details.title,
    data: req.body,
    app: app,
    trackerNameToExodus: trackerNameToExodus,
    jurisdictionData: jurisdictionData
  });
}));

router.post('/analysis/:appId',
  requireValidAppId,
  requireTurnstile('request_analysis'),
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

// About page
router.get('/about', (req, res) => {
  res.render('about', {
    title: 'About'
  });
});

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

  cache.invalidate('sitedata');
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

  cache.invalidate('sitedata');
  res.json({ ok: true });
}));

/*router.get('/sitemap.xml', async (req, res) => {
    try {
        const apps = await Apps.getAllApps();

        let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

        for (const app of apps) {
            sitemap += `
  <url>
    <loc>${req.protocol}://${req.get('host')}/analysis/${app.appid}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`;
        }

        sitemap += `
</urlset>`;

        res.header('Content-Type', 'application/xml');
        res.send(sitemap);
    } catch (err) {
        console.error('Error generating sitemap:', err);
        res.status(500).send('Error generating sitemap');
    }
});*/

module.exports = router; // make accessible to /app.js
