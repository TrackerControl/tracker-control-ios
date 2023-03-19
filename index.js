// .env saves configuration variables
require('dotenv').config();

// Load the actual app
const app = require('./server');

// Server express HTTP server
const port = process.env.PORT || 443;
const server = app.listen(port, () => {
  console.log(`Express is running on port ${server.address().port}`);
});
