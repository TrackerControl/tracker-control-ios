// Tells a waiting analyser that an app was queued, through an ntfy topic
// (https://ntfy.sh) that analyser/processQueue.sh subscribes to while idle.
// The analyser never polls the website, so without this a newly requested app
// waits until the analyser's next scheduled check. The message carries no
// data; it only ends the analyser's wait. Inert unless NTFY_TOPIC is set.
// ntfy.sh rate-limits anonymous publishing per IP address, which a shared
// hosting egress address can exhaust; NTFY_TOKEN (an ntfy account access
// token) publishes under the account's own limits instead.

const DEFAULT_SERVER = 'https://ntfy.sh';
const TIMEOUT_MS = 3000;
// ntfy topic names: letters, digits, dashes and underscores, at most 64.
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function wakeUrl({
  topic = process.env.NTFY_TOPIC,
  server = process.env.NTFY_SERVER
} = {}) {
  topic = (topic || '').trim();
  if (!topic) return null;
  if (!TOPIC_PATTERN.test(topic)) {
    console.error('NTFY_TOPIC must be 1-64 letters, digits, dashes or underscores; analyser wake-ups are disabled.');
    return null;
  }
  const base = ((server || '').trim() || DEFAULT_SERVER).replace(/\/+$/, '');
  return `${base}/${topic}`;
}

/**
 * Best effort: resolves to true if the notification was accepted, false
 * otherwise. Never throws, so callers need not await it. A missed wake-up only
 * delays the analysis until the analyser's next scheduled check.
 */
async function wakeAnalyser({
  fetchImpl = fetch,
  token = process.env.NTFY_TOKEN,
  ...options
} = {}) {
  const url = wakeUrl(options);
  if (!url) return false;

  token = (token || '').trim();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      body: 'wake',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) {
      console.error('Analyser wake-up rejected:', response.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Analyser wake-up failed:', err.message);
    return false;
  }
}

module.exports = { wakeAnalyser, wakeUrl };
