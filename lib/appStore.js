const https = require('https');

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let body = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`App Store request failed (${res.statusCode})`));

        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('App Store request timed out')));
    req.on('error', reject);
  });
}

function iconUrl(result) {
  return (result.artworkUrl100 || result.artworkUrl60 || '').replace('100x100bb', '512x512bb');
}

function normalize(result) {
  return {
    id: result.trackId,
    appId: result.bundleId,
    title: result.trackName,
    url: result.trackViewUrl,
    description: result.description,
    icon: iconUrl(result),
    genres: result.genres || [],
    genreIds: result.genreIds || [],
    primaryGenre: result.primaryGenreName,
    primaryGenreId: result.primaryGenreId,
    contentRating: result.contentAdvisoryRating,
    languages: result.languageCodesISO2A || [],
    size: result.fileSizeBytes,
    requiredOsVersion: result.minimumOsVersion,
    released: result.releaseDate,
    updated: result.currentVersionReleaseDate,
    releaseNotes: result.releaseNotes,
    version: result.version,
    price: result.price,
    currency: result.currency,
    free: Number(result.price) === 0,
    developerId: result.artistId,
    developer: result.artistName,
    developerUrl: result.artistViewUrl,
    score: result.averageUserRating,
    reviews: result.userRatingCount || 0,
    currentVersionScore: result.averageUserRatingForCurrentVersion,
    currentVersionReviews: result.userRatingCountForCurrentVersion || 0,
    screenshots: result.screenshotUrls || [],
    ipadScreenshots: result.ipadScreenshotUrls || [],
    appletvScreenshots: result.appletvScreenshotUrls || [],
    supportedDevices: result.supportedDevices || []
  };
}

async function search({ term, num, country }) {
  const params = new URLSearchParams({
    term,
    country,
    entity: 'software',
    limit: String(num || 5)
  });
  const data = await requestJson(`https://itunes.apple.com/search?${params.toString()}`);
  return (data.results || []).map(normalize);
}

async function app({ appId, country }) {
  const params = new URLSearchParams({
    bundleId: appId,
    country,
    entity: 'software'
  });
  const data = await requestJson(`https://itunes.apple.com/lookup?${params.toString()}`);
  const result = data.results && data.results[0];
  if (!result) throw new Error('App not found (404)');

  return normalize(result);
}

module.exports = { search, app };
