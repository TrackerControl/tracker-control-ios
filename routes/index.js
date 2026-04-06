const express = require('express');
const { check, validationResult } = require('express-validator');
const fs = require('fs');
const store = require('app-store-scraper');
const Apps = require('../models/Apps');
const jurisdiction = require('../lib/jurisdiction');
const cache = require('../lib/cache');

//const cron = require('node-cron');
//cron.schedule('0 0 * * *', Apps.resetLongProcessingJobs); // Runs every day at midnight

// Taken from https://reports.exodus-privacy.eu.org/api/trackers
const exodusTrackers = JSON.parse(fs.readFileSync('./exodusTrackers.json', 'utf-8'))
const trackerNameToExodus = {};
for (const [key, value] of Object.entries(exodusTrackers.trackers))
  trackerNameToExodus[value.name] = value;

const router = express.Router();
const COUNTRY = 'gb';

let lastPing = 0; // unix timestamp

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
  if (cached) return cached.data;

  try {
    const allApps = await Apps.getAllApps();
    const data = buildSiteData(allApps);
    if (data.appCount > 0) {
      cache.write('sitedata', data, {});
      console.log('Site data cache rebuilt for', data.appCount, 'apps');
    }
    return data;
  } catch (err) {
    console.error('DB error in getSiteData:', err.message);
    throw err;
  }
}

router.get('/', async (req, res) => {
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
});

// Statistics detail page
router.get('/statistics', async (req, res) => {
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
});

router.post('/search',
  [
    check('search')
      .isLength({ min: 1 })
      .withMessage('Please enter a search term'),
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (errors.isEmpty()) {
      try {
        const result = await store.search({
          term: req.body.search,
          num: 5,
          country : COUNTRY,
        });

        res.render('form', {
          title: 'Search app',
          errors: errors.array(),
          data: req.body,
          searchResults: result
        });
      } catch (err) {
        console.log(err);
        res.send("Error while searching. Try again later.")
      }
    } else {
      res.render('form', {
        title: 'Search app',
        errors: errors.array(),
        data: req.body,
      });
    };
});

router.get('/analysis/:appId', async (req, res) => {
  if (!req.params.appId)
    return res.status(400).send('Please provide app');
  let appId = req.params.appId;

  console.log('Fetching', appId);

  let app = await Apps.findApp(appId);
  if (app) {
    if (app.analysis) {
      const analysis = app.analysis;

      if (analysis.success !== undefined && analysis.success === false)
        app.analysisFailure = "Analysis failed."
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
  } else {
    app = {};
    app.queueCount = await Apps.countQueue();

    try {
        // Retrieve information about apps from App Store
        app.details = await store.app({appId: appId, country: COUNTRY});
      } catch (err) {
        console.log(err);

        if (String(err).includes("App not found (404)"))
          return res.status(404).send('App not found on App Store.');
        else
          return res.status(500).send('Downloading of app information failed. Please try again later.');
      }

      if (!app.details.free)
        return res.status(400).send('Can\'t analyse non-free apps.');

      // Save to database
      try {
        Apps.addApp(appId, app.details);
      } catch (err) {
        console.log(err);

        return res.status(500).send('Error adding app. Please try again later.');
      }
  }

  // Compute jurisdiction analysis if trackers exist
  let jurisdictionData = null;
  if (app.analysis && app.analysis.trackers && app.analysis.success !== false) {
    jurisdictionData = jurisdiction.analyseApp(app.analysis);
    jurisdictionData.meta = jurisdiction.classificationMeta[jurisdictionData.classification];
    jurisdictionData.sovereigntyNote = jurisdiction.sovereigntyNotes[jurisdictionData.classification];
  }

  res.render('form', {
    title: app.details.title,
    data: req.body,
    app: app,
    trackerNameToExodus: trackerNameToExodus,
    jurisdictionData: jurisdictionData
  });
});

// About page
router.get('/about', async (req, res) => {
  res.render('about', {
    title: 'About'
  });
});

// serve next task to analyser
router.get('/queue', async (req, res) => {
  if (!req.query.password
    || req.query.password != process.env.UPLOAD_PASSWORD)
    return res.status(400).end('Please provide correct password.');

  let app = await Apps.nextApp();
  console.log(app);

  if (!app)
    return res.send();

  res.send(app.appid);
});

// enable analyser to report online status
router.get('/ping', async (req, res) => {
  if (!req.query.password
    || req.query.password != process.env.UPLOAD_PASSWORD)
    return res.status(400).end('Please provide correct password.');

    lastPing = Date.now();

    res.send("online");
});

// upload analysis results
router.post('/uploadAnalysis', async (req, res) => {
  if (!req.query.password
    || req.query.password != process.env.UPLOAD_PASSWORD)
    return res.status(400).send('Please provide correct password.');

  if (!req.query.appId || !req.query.analysisVersion)
    return res.status(400).send('Please provide appId and analysisVersion');
  const appId = req.query.appId;
  const analysisVersion = req.query.analysisVersion;

  console.log('Updating', appId);

  if (!req.body)
    return res.status(400).end("Please provide valid JSON");
  const analysis = req.body;

  const result = await Apps.updateAnalysis(appId, analysis, analysisVersion);
  cache.invalidate('sitedata');
  res.send(result);
});

// avoid a loop: only analyse each app once
router.post('/reportAnalysisFailure', async (req, res) => {
  if (!req.query.password
    || req.query.password != process.env.UPLOAD_PASSWORD)
    return res.status(400).send('Please provide correct password.');

  if (!req.query.appId || !req.query.analysisVersion)
    return res.status(400).send('Please provide appId and analysisVersion');

  const logs = req.body; // should contain the log
  console.log('Removing from queue', req.query.appId, logs);

  const result = await Apps.updateAnalysis(req.query.appId, { success: false, logs: logs }, req.query.analysisVersion);
  cache.invalidate('sitedata');
  res.send(result);
});

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
