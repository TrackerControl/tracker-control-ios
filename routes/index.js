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
const HOMEPAGE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

let lastPing = 0; // unix timestamp

// ping from analyser in past hour?
router.use(function (req, res, next) {
  res.locals.analyserOnline = lastPing > Date.now() - 1000*60*60;
  next();
});

function computeTopTrackers(allApps) {
  let appCount = 0.0;
  let trackerCounts = {};
  for (const oneApp of allApps) {
    if (oneApp.analysis && oneApp.analysis.success !== false && oneApp.analysis.trackers) {
      appCount++;

      for (const tracker of Object.keys(oneApp.analysis.trackers))
        trackerCounts[tracker] = trackerCounts[tracker] ? trackerCounts[tracker] + 1 : 1;
    }
  }

  let sortedTrackerCounts = Object.keys(trackerCounts).map(
    (key) => [key, (trackerCounts[key] / appCount * 100).toFixed(1)]
  );
  sortedTrackerCounts.sort((first, second) =>
    second[1] - first[1]
  );

  return [appCount.toFixed(0), sortedTrackerCounts.slice(0, 10)];
}

function enrichLastAnalysed(lastAnalysed) {
  for (const lastApp of lastAnalysed) {
    if (lastApp.analysis && lastApp.details) {
      lastApp.title = lastApp.details.title;
      lastApp.success = lastApp.analysis.success;
      if (lastApp.analysis.trackers && lastApp.analysis.success !== false) {
        const jd = jurisdiction.analyseApp(lastApp.analysis);
        lastApp.jurisdictionClass = jd.classification;
        lastApp.jurisdictionMeta = jurisdiction.classificationMeta[jd.classification];
      }
    }
  }
  return lastAnalysed;
}

/**
 * Build all homepage data from DB, write to cache, return it.
 */
async function buildHomepageData() {
  const [lastAnalysed, allApps] = await Promise.all([
    Apps.lastAnalysed(),
    Apps.getAllApps()
  ]);

  const topTrackers = computeTopTrackers(allApps);
  const jurisdictionStats = jurisdiction.computeAggregateStats(allApps);
  jurisdictionStats.xrayCompanyCount = jurisdiction.xrayCompanyCount;

  const data = {
    lastAnalysed: enrichLastAnalysed(lastAnalysed),
    topTrackers,
    jurisdictionStats
  };

  cache.write('homepage', data);
  return data;
}

let refreshInProgress = false;

/**
 * Refresh homepage cache in background (non-blocking).
 */
function refreshHomepageCacheInBackground() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  buildHomepageData()
    .then(() => console.log('Homepage cache refreshed'))
    .catch(err => console.error('Background cache refresh failed:', err.message))
    .finally(() => { refreshInProgress = false; });
}

router.get('/', async (req, res) => {
  // Try cache first
  const cached = cache.get('homepage', HOMEPAGE_CACHE_TTL);

  if (cached && cached.fresh) {
    // Cache is fresh — serve immediately
    return res.render('form', {
      title: 'App Privacy Checker',
      lastAnalysed: cached.data.lastAnalysed,
      topTrackers: cached.data.topTrackers,
      jurisdictionStats: cached.data.jurisdictionStats,
      jurisdictionMeta: jurisdiction.classificationMeta,
      europeanAlternatives: jurisdiction.europeanAlternatives
    });
  }

  // Cache is stale or missing — try DB
  try {
    const data = await buildHomepageData();
    return res.render('form', {
      title: 'App Privacy Checker',
      lastAnalysed: data.lastAnalysed,
      topTrackers: data.topTrackers,
      jurisdictionStats: data.jurisdictionStats,
      jurisdictionMeta: jurisdiction.classificationMeta,
      europeanAlternatives: jurisdiction.europeanAlternatives
    });
  } catch (err) {
    console.error('Homepage DB error:', err.message);

    // DB failed — serve stale cache if available
    if (cached) {
      console.log('Serving stale cache');
      return res.render('form', {
        title: 'App Privacy Checker',
        lastAnalysed: cached.data.lastAnalysed,
        topTrackers: cached.data.topTrackers,
        jurisdictionStats: cached.data.jurisdictionStats,
        jurisdictionMeta: jurisdiction.classificationMeta,
        europeanAlternatives: jurisdiction.europeanAlternatives
      });
    }

    // No cache at all — render empty homepage
    return res.render('form', {
      title: 'App Privacy Checker',
      lastAnalysed: [],
      topTrackers: ['0', []],
      jurisdictionStats: null,
      jurisdictionMeta: jurisdiction.classificationMeta,
      europeanAlternatives: jurisdiction.europeanAlternatives
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
  refreshHomepageCacheInBackground();
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
