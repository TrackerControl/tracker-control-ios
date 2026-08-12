// .env saves configuration variables
require('dotenv').config();

const { getOriginSecret } = require('./lib/originGate');
const siteUrl = require('./lib/siteUrl');

// Load the actual app
const app = require('./server');

// tell Express that we're behind a proxy (in production) so that it resolves internal URLs correctly
var env = process.env.NODE_ENV || 'development';
if (env == 'production') {
  app.set('trust proxy', 1);
  if (!getOriginSecret())
    console.warn('CLOUDFLARE_ORIGIN_SECRET is not set: the origin is trusted to be reachable only through Cloudflare.');
  // Every route builds canonical/social URLs from this, so a missing value
  // fails the request rather than degrading it. Refuse to boot instead of
  // serving 500s from a process the platform considers healthy.
  try {
    siteUrl.assertSiteUrlConfiguration();
  } catch (err) {
    console.error(`Site URL configuration error: ${err.message}`);
    throw err;
  }
}

// Server express HTTP server
const port = process.env.PORT || 3000;
const server = app.listen(port, '::', () => {
  console.log(`Express is running on [::]:${server.address().port}`);
});
