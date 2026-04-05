const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'trackerJurisdictions.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));

const companies = db.companies;
const domains = db.domains;
const regionDefs = db.regionDefinitions;

// Build a case-insensitive lookup for company names and aliases
const companyLookup = {};
for (const [name, info] of Object.entries(companies)) {
  companyLookup[name.toLowerCase()] = { name, ...info };
  if (info.aliases) {
    for (const alias of info.aliases) {
      companyLookup[alias.toLowerCase()] = { name, ...info };
    }
  }
}

// Build domain lookup (lowercase)
const domainLookup = {};
for (const [domain, companyName] of Object.entries(domains)) {
  domainLookup[domain.toLowerCase()] = companyName;
}

/**
 * Classify a country code into a region
 */
function classifyRegion(countryCode) {
  if (!countryCode) return 'Other';
  const code = countryCode.toUpperCase();
  if (regionDefs.US.includes(code)) return 'US';
  if (regionDefs.European.includes(code)) return 'European';
  if (regionDefs.CN.includes(code)) return 'CN';
  return 'Other';
}

/**
 * Get country flag emoji from country code
 */
function countryFlag(countryCode) {
  if (!countryCode) return '';
  const code = countryCode.toUpperCase();
  const flagOffset = 0x1F1E6;
  const asciiOffset = 0x41;
  const firstChar = String.fromCodePoint(code.charCodeAt(0) - asciiOffset + flagOffset);
  const secondChar = String.fromCodePoint(code.charCodeAt(1) - asciiOffset + flagOffset);
  return firstChar + secondChar;
}

/**
 * Get full country name from code
 */
const countryNames = {
  US: 'United States', GB: 'United Kingdom', DE: 'Germany', FR: 'France',
  NL: 'Netherlands', IE: 'Ireland', ES: 'Spain', IT: 'Italy', PL: 'Poland',
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus',
  CZ: 'Czech Republic', DK: 'Denmark', EE: 'Estonia', FI: 'Finland',
  GR: 'Greece', HU: 'Hungary', LV: 'Latvia', LT: 'Lithuania', LU: 'Luxembourg',
  MT: 'Malta', PT: 'Portugal', RO: 'Romania', SK: 'Slovakia', SI: 'Slovenia',
  SE: 'Sweden', NO: 'Norway', IS: 'Iceland', LI: 'Liechtenstein',
  CN: 'China', IL: 'Israel', IN: 'India', JP: 'Japan', KR: 'South Korea',
  NZ: 'New Zealand', RU: 'Russia', BR: 'Brazil', AU: 'Australia', CA: 'Canada',
  SG: 'Singapore'
};

function getCountryName(code) {
  return countryNames[code] || code;
}

/**
 * Resolve a tracker name to a company
 */
function resolveTrackerName(trackerName) {
  if (!trackerName) return null;
  const key = trackerName.toLowerCase().trim();
  if (companyLookup[key]) return companyLookup[key];

  // Try partial matching: check if tracker name contains a known company name
  for (const [lookupKey, info] of Object.entries(companyLookup)) {
    if (key.includes(lookupKey) || lookupKey.includes(key)) {
      return info;
    }
  }
  return null;
}

/**
 * Resolve a hostname to a company via domain matching
 */
function resolveHost(hostname) {
  if (!hostname) return null;
  const host = hostname.toLowerCase().trim();

  // Exact match
  if (domainLookup[host]) {
    const companyName = domainLookup[host];
    const key = companyName.toLowerCase();
    return companyLookup[key] || { name: companyName, country: 'US' };
  }

  // Strip subdomains iteratively
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (domainLookup[parent]) {
      const companyName = domainLookup[parent];
      const key = companyName.toLowerCase();
      return companyLookup[key] || { name: companyName, country: 'US' };
    }
  }

  return null;
}

/**
 * Get the ultimate parent company name
 */
function getUltimateParent(companyInfo) {
  if (!companyInfo) return null;
  if (companyInfo.parent) {
    const parentKey = companyInfo.parent.toLowerCase();
    if (companyLookup[parentKey]) {
      return companyLookup[parentKey].name;
    }
    return companyInfo.parent;
  }
  return companyInfo.name;
}

/**
 * Analyse jurisdiction for a single app's tracker data.
 *
 * @param {Object} analysis - The app's analysis object with .trackers (name->company map)
 * @returns {Object} Jurisdiction analysis result
 */
function analyseApp(analysis) {
  if (!analysis || !analysis.trackers || analysis.success === false) {
    return {
      classification: 'no_tracking',
      trackerDetails: [],
      companySummary: {},
      regionBreakdown: {},
      countryBreakdown: {}
    };
  }

  const trackerNames = Object.keys(analysis.trackers);
  if (trackerNames.length === 0) {
    return {
      classification: 'no_tracking',
      trackerDetails: [],
      companySummary: {},
      regionBreakdown: {},
      countryBreakdown: {}
    };
  }

  const trackerDetails = [];
  const resolvedCompanies = {}; // parentName -> { country, region, trackers[] }
  let unresolvedCount = 0;

  for (const trackerName of trackerNames) {
    const resolved = resolveTrackerName(trackerName);

    if (resolved) {
      const parentName = getUltimateParent(resolved);
      const country = resolved.country;
      const region = classifyRegion(country);
      const func = resolved.function || 'Unknown';

      trackerDetails.push({
        name: trackerName,
        company: parentName,
        country: country,
        countryName: getCountryName(country),
        flag: countryFlag(country),
        region: region,
        function: func
      });

      if (!resolvedCompanies[parentName]) {
        resolvedCompanies[parentName] = {
          country: country,
          region: region,
          countryName: getCountryName(country),
          flag: countryFlag(country),
          trackers: []
        };
      }
      resolvedCompanies[parentName].trackers.push(trackerName);
    } else {
      unresolvedCount++;
      trackerDetails.push({
        name: trackerName,
        company: null,
        country: null,
        countryName: null,
        flag: null,
        region: 'Unresolved',
        function: 'Unknown'
      });
    }
  }

  // Region breakdown by unique companies
  const regionBreakdown = {};
  const countryBreakdown = {};
  for (const [companyName, info] of Object.entries(resolvedCompanies)) {
    regionBreakdown[info.region] = (regionBreakdown[info.region] || 0) + 1;
    countryBreakdown[info.country] = (countryBreakdown[info.country] || 0) + 1;
  }

  const resolvedCount = Object.keys(resolvedCompanies).length;
  const regions = Object.keys(regionBreakdown);

  // Classify the app
  let classification;
  if (resolvedCount === 0 && unresolvedCount > 0) {
    classification = 'unresolved_only';
  } else if (resolvedCount === 0) {
    classification = 'no_tracking';
  } else if (regions.length === 1 && regions[0] === 'US') {
    classification = 'us_only';
  } else if (regions.length === 1 && regions[0] === 'European') {
    classification = 'european_only';
  } else if (regions.includes('US')) {
    classification = 'mixed_with_us';
  } else {
    classification = 'mixed_no_us';
  }

  return {
    classification,
    trackerDetails,
    companySummary: resolvedCompanies,
    regionBreakdown,
    countryBreakdown,
    resolvedCount,
    unresolvedCount,
    totalTrackers: trackerNames.length
  };
}

/**
 * Classification metadata for display
 */
const classificationMeta = {
  no_tracking: {
    label: 'No tracking detected',
    icon: '&#x2705;',
    cssClass: 'jurisdiction-none',
    color: '#28a745'
  },
  unresolved_only: {
    label: 'Unresolved trackers',
    icon: '&#x2753;',
    cssClass: 'jurisdiction-unresolved',
    color: '#6c757d'
  },
  us_only: {
    label: 'US-only tracking',
    icon: '&#x1F1FA;&#x1F1F8;',
    cssClass: 'jurisdiction-us',
    color: '#dc3545'
  },
  european_only: {
    label: 'European-only tracking',
    icon: '&#x1F1EA;&#x1F1FA;',
    cssClass: 'jurisdiction-eu',
    color: '#28a745'
  },
  mixed_with_us: {
    label: 'Mixed jurisdiction (incl. US)',
    icon: '&#x1F30D;',
    cssClass: 'jurisdiction-mixed-us',
    color: '#fd7e14'
  },
  mixed_no_us: {
    label: 'Mixed jurisdiction (no US)',
    icon: '&#x1F30D;',
    cssClass: 'jurisdiction-mixed',
    color: '#007bff'
  }
};

/**
 * Sovereignty risk explanatory texts
 */
const sovereigntyNotes = {
  us_only: 'All tracking in this app is controlled by US-based companies. Under the US CLOUD Act, US authorities can compel disclosure of data held by these companies regardless of where it is stored. This data may not receive equivalent protection to that mandated by EU/UK GDPR.',
  european_only: 'All tracking in this app uses infrastructure controlled by companies based in EU/UK/EEA countries, subject to GDPR and equivalent data protection frameworks.',
  mixed_with_us: 'This app\'s tracking data flows to companies in multiple jurisdictions. Data sent to US-based trackers may be subject to the CLOUD Act, which allows US authorities to compel disclosure regardless of where data is stored.',
  mixed_no_us: 'This app\'s tracking data flows to companies in multiple non-US jurisdictions. Data protection depends on the specific laws of each country involved.',
  no_tracking: 'No tracking was detected in this app, so there are no jurisdictional concerns related to third-party tracking.',
  unresolved_only: 'Trackers were detected but could not be mapped to known companies. The jurisdictional risk cannot be determined.'
};

/**
 * European alternatives reference data
 */
const europeanAlternatives = [
  { function: 'Integrated analytics', usDominant: 'Firebase (Google)', euAlternative: 'None at scale', adopted: false },
  { function: 'Crash reporting', usDominant: 'Crashlytics (Google)', euAlternative: 'None (HockeyApp was acquired by Microsoft)', adopted: false },
  { function: 'Mobile advertising', usDominant: 'Google AdMob, Meta', euAlternative: 'Criteo (FR, limited)', adopted: true },
  { function: 'Attribution', usDominant: 'AppsFlyer (Israel)', euAlternative: 'Adjust (DE, acquired by AppLovin US)', adopted: false },
  { function: 'Authentication', usDominant: 'Google/Apple Sign-In', euAlternative: 'None at scale', adopted: false },
  { function: 'Maps SDK', usDominant: 'Google Maps', euAlternative: 'None at scale', adopted: false }
];

/**
 * Compute aggregate jurisdiction statistics across all apps
 */
function computeAggregateStats(allApps) {
  const stats = {
    totalApps: 0,
    classificationCounts: {},
    categoryBreakdown: {},
    topCompanies: {},
    regionTotals: {}
  };

  for (const app of allApps) {
    if (!app.analysis || app.analysis.success === false) continue;
    if (!app.analysis.trackers || Object.keys(app.analysis.trackers).length === 0) continue;

    stats.totalApps++;

    const jurisdiction = analyseApp(app.analysis);

    // Classification counts
    stats.classificationCounts[jurisdiction.classification] =
      (stats.classificationCounts[jurisdiction.classification] || 0) + 1;

    // Category breakdown
    const category = (app.details && app.details.primaryGenre) || 'Unknown';
    if (!stats.categoryBreakdown[category]) {
      stats.categoryBreakdown[category] = { total: 0, classifications: {} };
    }
    stats.categoryBreakdown[category].total++;
    stats.categoryBreakdown[category].classifications[jurisdiction.classification] =
      (stats.categoryBreakdown[category].classifications[jurisdiction.classification] || 0) + 1;

    // Top companies
    for (const [companyName, companyInfo] of Object.entries(jurisdiction.companySummary)) {
      if (!stats.topCompanies[companyName]) {
        stats.topCompanies[companyName] = {
          count: 0,
          country: companyInfo.country,
          countryName: companyInfo.countryName,
          flag: companyInfo.flag,
          region: companyInfo.region
        };
      }
      stats.topCompanies[companyName].count++;
    }

    // Region totals (per-company, deduplicated per app)
    for (const [region, count] of Object.entries(jurisdiction.regionBreakdown)) {
      stats.regionTotals[region] = (stats.regionTotals[region] || 0) + 1;
    }
  }

  // Sort top companies
  stats.topCompaniesSorted = Object.entries(stats.topCompanies)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([name, info]) => ({ name, ...info }));

  // Sort categories by total
  stats.categoriesSorted = Object.entries(stats.categoryBreakdown)
    .filter(([_, info]) => info.total >= 3) // only show categories with enough data
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, info]) => ({
      name,
      total: info.total,
      classifications: info.classifications,
      usOnlyPct: info.total > 0 ? ((info.classifications.us_only || 0) / info.total * 100).toFixed(1) : '0.0',
      euOnlyPct: info.total > 0 ? ((info.classifications.european_only || 0) / info.total * 100).toFixed(1) : '0.0'
    }));

  // Classification percentages
  stats.classificationPcts = {};
  for (const [cls, count] of Object.entries(stats.classificationCounts)) {
    stats.classificationPcts[cls] = stats.totalApps > 0
      ? (count / stats.totalApps * 100).toFixed(1)
      : '0.0';
  }

  return stats;
}

module.exports = {
  analyseApp,
  classificationMeta,
  sovereigntyNotes,
  europeanAlternatives,
  computeAggregateStats,
  resolveTrackerName,
  resolveHost,
  classifyRegion,
  countryFlag,
  getCountryName,
  dbVersion: db.version,
  dbLastUpdated: db.lastUpdated
};
