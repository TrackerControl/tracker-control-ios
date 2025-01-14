// load express server
const express = require('express');
const app = express();

// load helpers
const path = require('path');
const helmet = require('helmet')
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit')
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
if(os.hostname().indexOf("local") <= -1) { // only on remote host
  const limiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 100, // Limit each IP to 100 requests per `window`
    standardHeaders: false,
    legacyHeaders: false,
  })
  app.use(limiter)
}

// use pug as templates engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// set up parsing of form inputs and of application/json
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.text());

// serve static files
app.use(express.static('public'));
app.use('/static', express.static('static'))

// serve favicon
app.use('/favicon.ico', express.static('favicon.ico'));

// load routes from /routes/index.js
const routes = require('./routes/index');
app.use('/', routes);

module.exports = app; // make accessible to /start.js
