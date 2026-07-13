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

module.exports = {
  APP_ID_PATTERN_SOURCE,
  MAX_APP_ID_LENGTH,
  isValidAppId
};
