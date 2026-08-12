'use strict';

// Absolute base URL of this deployment, used for canonical links, social card
// metadata, robots.txt and the sitemap.
//
// SITE_URL pins the origin when the site runs behind a proxy that terminates
// TLS, where req.protocol would otherwise report http, and so that an
// untrusted Host header cannot become a public canonical URL. It is therefore
// required in production. index.js asserts it at startup: without that, the
// first request would throw from routing middleware and every route — the
// health check included — would answer 500 on a deployment that looked
// healthy at boot.

function configuredSiteUrl() {
  return (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
}

function getSiteUrlConfigurationError() {
  if (process.env.NODE_ENV === 'production' && !configuredSiteUrl())
    return 'SITE_URL is not set';

  return null;
}

function assertSiteUrlConfiguration() {
  const error = getSiteUrlConfigurationError();
  if (error) throw new Error(error);
}

function siteBaseUrl(req) {
  const configured = configuredSiteUrl();
  if (configured) return configured;

  assertSiteUrlConfiguration();
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = {
  siteBaseUrl,
  getSiteUrlConfigurationError,
  assertSiteUrlConfiguration
};
