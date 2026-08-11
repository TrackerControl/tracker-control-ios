// load express server
const express = require('express');
const app = express();

// load helpers
const path = require('path');
const helmet = require('helmet')
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit')
const { analyserAuthenticated } = require('./lib/auth');
const { originGate } = require('./lib/originGate');
require('dotenv').config();

// improve express security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", "*.mzstatic.com"],
    },
  },
  crossOriginEmbedderPolicy: false
}))
app.disable('x-powered-by')

// Reject anything that did not come through Cloudflare, so the WAF challenge
// rules protecting /search and the analysis request cannot simply be skipped.
app.use(originGate())

const os = require('os');
const analyserPaths = new Set([
  '/queue',
  '/ping',
  '/uploadanalysis',
  '/reportanalysisfailure'
]);

// Express routing is case-insensitive and lenient about trailing slashes,
// so normalise the same way before matching against the analyser path set —
// otherwise `/UploadAnalysis` or `/queue/` reach the handlers while skipping
// this gate.
const isAnalyserPath = (req) =>
  analyserPaths.has(req.path.toLowerCase().replace(/\/+$/, ''));

// /search and /request/:appId are GETs only so that a Cloudflare challenge can
// replay them; each one still reaches the App Store. The method therefore does
// not separate cheap from expensive here, and they are budgeted as the form
// submissions they are.
const appStorePaths = (path) =>
  path === '/search' || path === '/request' || path.startsWith('/request/');

const isAppStorePath = (req) =>
  appStorePaths(req.path.toLowerCase().replace(/\/+$/, ''));

// Reads of the published pages are served from the cached site data and
// reverse index, so they cost far less than an App Store call. They also
// arrive in very different volumes: sitemap.xml points crawlers at every app,
// tracker and company URL, and a crawler works through those from a narrow
// range of addresses. Sharing one budget between the two means either
// throttling a normal crawl or loosening the limit that actually matters, so
// they are budgeted separately.
const isBrowseRequest = (req) =>
  (req.method === 'GET' || req.method === 'HEAD')
  && !isAnalyserPath(req)
  && !isAppStorePath(req);

if(os.hostname().indexOf("local") <= -1) { // only on remote host
  const windowMs = 5 * 60 * 1000; // 5 minutes
  const skipAnalyser = (req) => isAnalyserPath(req) && analyserAuthenticated(req);

  // Everything that is not a cacheable page view: the App Store entry points,
  // the analysis request POST, and analyser endpoints called without
  // credentials.
  app.use(rateLimit({
    windowMs,
    max: Number(process.env.RATE_LIMIT_FORM_MAX) || 20,
    standardHeaders: false,
    legacyHeaders: false,
    skip: (req) => skipAnalyser(req) || isBrowseRequest(req),
  }))

  app.use(rateLimit({
    windowMs,
    max: Number(process.env.RATE_LIMIT_BROWSE_MAX) || 300,
    standardHeaders: false,
    legacyHeaders: false,
    skip: (req) => skipAnalyser(req) || !isBrowseRequest(req),
  }))
}

const analyserBodyLimit = process.env.BODY_LIMIT || '25mb';
const publicFormBodyLimit = process.env.PUBLIC_FORM_BODY_LIMIT || '100kb';

app.use((req, res, next) => {
  if (isAnalyserPath(req) && !analyserAuthenticated(req))
    return res.status(400).send('Please provide correct password.');

  next();
});

// use pug as templates engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// Search is a GET, so the only public form body is the analysis request. Large
// analyser payload parsers are mounted on their authenticated endpoints so
// arbitrary public and nonexistent routes cannot consume the analyser body
// allowance.
app.post('/analysis/:appId', bodyParser.urlencoded({
  extended: true,
  limit: publicFormBodyLimit
}));
app.post('/uploadAnalysis', bodyParser.json({ limit: analyserBodyLimit }));
app.post('/reportAnalysisFailure', express.text({ limit: analyserBodyLimit }));

// serve static files
app.use(express.static('public'));
app.use('/static', express.static('static'))

// serve favicon
app.use('/favicon.ico', express.static('favicon.ico'));

// load routes from /routes/index.js
const routes = require('./routes/index');
app.use('/', routes);

// Express 4 requires rejected async handlers to call next(err). Route handlers
// use asyncHandler for that bridge and all errors terminate here.
app.use((err, req, res, next) => {
  if (res.headersSent)
    return next(err);

  const errorStatus = err.status || err.statusCode;
  const status = Number.isInteger(errorStatus)
    && errorStatus >= 400
    && errorStatus <= 599
    ? errorStatus
    : 500;
  if (status >= 500)
    console.error('Request failed:', err.stack || err.message);
  const message = err.expose ? err.message : 'Internal server error.';
  return res.status(status).send(message);
});

module.exports = app; // make accessible to /start.js
