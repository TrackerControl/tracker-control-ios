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
    },
  },
  crossOriginEmbedderPolicy: false
}))
app.disable('x-powered-by')

const os = require('os');
const analyserPaths = new Set([
  '/queue',
  '/ping',
  '/uploadAnalysis',
  '/reportAnalysisFailure'
]);

if(os.hostname().indexOf("local") <= -1) { // only on remote host
  const limiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // Limit each IP to 10 requests per `window`
    standardHeaders: false,
    legacyHeaders: false,
    skip: (req) => analyserPaths.has(req.path) && analyserAuthenticated(req),
  })
  app.use(limiter)
}

const bodyLimit = process.env.BODY_LIMIT || '25mb';

app.use((req, res, next) => {
  if (analyserPaths.has(req.path) && !analyserAuthenticated(req))
    return res.status(400).send('Please provide correct password.');

  next();
});

// use pug as templates engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// set up parsing of form inputs and of application/json
app.use(bodyParser.urlencoded({ extended: true, limit: bodyLimit }));
app.use(bodyParser.json({ limit: bodyLimit }));
app.use(express.text({ limit: bodyLimit }));

// serve static files
app.use(express.static('public'));
app.use('/static', express.static('static'))

// serve favicon
app.use('/favicon.ico', express.static('favicon.ico'));

// load routes from /routes/index.js
const routes = require('./routes/index');
app.use('/', routes);

module.exports = app; // make accessible to /start.js
