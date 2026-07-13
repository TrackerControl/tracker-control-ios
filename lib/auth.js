const crypto = require('crypto');

function getBearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// Constant-time comparison. Hash both sides to a fixed length first so that
// timingSafeEqual never sees mismatched buffer lengths (which would throw and
// also leak the secret's length).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function analyserAuthenticated(req) {
  const password = process.env.UPLOAD_PASSWORD;
  if (!password) return false;

  const bearerToken = getBearerToken(req);
  if (bearerToken === null) return false;

  return safeEqual(bearerToken, password);
}

module.exports = {
  analyserAuthenticated
};
