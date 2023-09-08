// .env saves configuration variables
require('dotenv').config();

// Load the actual app
const app = require('./server');

// tell Express that we're behind a proxy (in production) so that it resolves internal URLs correctly
var env = process.env.NODE_ENV || 'development';
if (env == 'production')
  app.enable('trust proxy');

// Server express HTTP server
const port = process.env.PORT || 443;
const server = app.listen(port, () => {
  console.log(`Express is running on port ${server.address().port}`);
});
