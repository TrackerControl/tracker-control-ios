// load express server
const express = require('express');
const app = express();

// load helpers
const path = require('path');
const helmet = require('helmet')
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit')
const { analyserAuthenticated } = require('./lib/auth');
require('dotenv').config();

// improve express security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", "*.mzstatic.com"],
      "script-src": ["'self'", "https://challenges.cloudflare.com"],
      "connect-src": ["'self'", "https://challenges.cloudflare.com"],
      "frame-src": ["'self'", "https://challenges.cloudflare.com"],
    },
  },
  crossOriginEmbedderPolicy: false
}))
app.disable('x-powered-by')

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

if(os.hostname().indexOf("local") <= -1) { // only on remote host
  const limiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // Limit each IP to 10 requests per `window`
    standardHeaders: false,
    legacyHeaders: false,
    skip: (req) => isAnalyserPath(req) && analyserAuthenticated(req),
  })
  app.use(limiter)
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

// Public requests only need the small search form parser. Large analyser
// payload parsers are mounted on their authenticated endpoints so arbitrary
// public and nonexistent routes cannot consume the analyser body allowance.
app.post('/search', bodyParser.urlencoded({
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
