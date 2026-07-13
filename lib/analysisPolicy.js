// Analysis scheduling policy, driven by environment variables. Centralised
// here so models/Apps.js and the reporting scripts read identical defaults.
//
// Callers that load .env themselves (e.g. scripts using dotenv.config())
// must require this module AFTER dotenv.config() has run, since the values
// below are parsed once at require time.
const CURRENT_ANALYSIS_VERSION = parseInt(process.env.CURRENT_ANALYSIS_VERSION || process.env.ANALYSIS_VERSION || '4', 10);
const STALE_ANALYSIS_DAYS = parseInt(process.env.STALE_ANALYSIS_DAYS || '180', 10);
const PROCESSING_TIMEOUT_MINUTES = parseInt(process.env.PROCESSING_TIMEOUT_MINUTES || '120', 10);

module.exports = {
  CURRENT_ANALYSIS_VERSION,
  STALE_ANALYSIS_DAYS,
  PROCESSING_TIMEOUT_MINUTES
};
