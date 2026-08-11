// .env saves configuration variables
require('dotenv').config();

const { assertOriginConfiguration } = require('./lib/originGate');

// Load the actual app
const app = require('./server');

// tell Express that we're behind a proxy (in production) so that it resolves internal URLs correctly
var env = process.env.NODE_ENV || 'development';
if (env == 'production') {
  app.set('trust proxy', 1);
  try {
    assertOriginConfiguration();
  } catch (err) {
    console.error(`Origin protection configuration error: ${err.message}`);
    throw err;
  }
}

// Server express HTTP server
const port = process.env.PORT || 3000;
const server = app.listen(port, '::', () => {
  console.log(`Express is running on [::]:${server.address().port}`);
});
