function getBearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function analyserAuthenticated(req) {
  const password = process.env.UPLOAD_PASSWORD;
  if (!password) return false;

  const bearerToken = getBearerToken(req);
  return bearerToken === password;
}

module.exports = {
  analyserAuthenticated
};
