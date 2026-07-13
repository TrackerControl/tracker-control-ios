const MAX_APP_ID_LENGTH = 255;
const APP_ID_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9.-]*$';
const APP_ID_PATTERN = new RegExp(APP_ID_PATTERN_SOURCE);

function isValidAppId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_APP_ID_LENGTH
    && APP_ID_PATTERN.test(value)
    && !value.endsWith('.');
}

// Bundle IDs are case-insensitive on the App Store; lookups may return the
// canonical casing rather than the one requested.
function isSameAppId(a, b) {
  return typeof a === 'string'
    && typeof b === 'string'
    && a.toLowerCase() === b.toLowerCase();
}

// SQL predicate that matches the same validity rules as isValidAppId(),
// for use in queries against the appid column. patternParamIndex and
// lengthParamIndex are the 1-based positional parameter indices to bind
// APP_ID_PATTERN_SOURCE and MAX_APP_ID_LENGTH to (e.g. appIdSqlPredicate(2, 3)
// produces a predicate using $2 and $3).
function appIdSqlPredicate(patternParamIndex, lengthParamIndex) {
  return `appid ~ $${patternParamIndex} AND appid !~ '[.]$' AND length(appid) <= $${lengthParamIndex}`;
}

module.exports = {
  APP_ID_PATTERN_SOURCE,
  MAX_APP_ID_LENGTH,
  isSameAppId,
  isValidAppId,
  appIdSqlPredicate
};
