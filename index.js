// .env saves configuration variables
require('dotenv').config();

const turnstile = require('./lib/turnstile');

// Load the actual app
const app = require('./server');

// tell Express that we're behind a proxy (in production) so that it resolves internal URLs correctly
var env = process.env.NODE_ENV || 'development';
if (env == 'production') {
  app.set('trust proxy', 1);
  try {
    turnstile.assertTurnstileConfiguration();
  } catch (err) {
    console.error(`Turnstile configuration error: ${err.message}`);
    throw err;
  }
}

// Server express HTTP server
const port = process.env.PORT || 3000;
const server = app.listen(port, '::', () => {
  console.log(`Express is running on [::]:${server.address().port}`);
});
