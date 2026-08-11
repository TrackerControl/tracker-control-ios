'use strict';

async function withAdvisoryLock(client, keys, task, logger = console, { tryLock = false } = {}) {
  logger.log(`Waiting for advisory lock ${keys.join(':')}`);
  const lockResult = await client.query(
    tryLock
      ? 'SELECT pg_try_advisory_lock($1, $2)'
      : 'SELECT pg_advisory_lock($1, $2)',
    keys
  );
  if (tryLock && !lockResult.rows[0].pg_try_advisory_lock) {
    logger.log(`Advisory lock ${keys.join(':')} is already held; skipping.`);
    return { skipped: true };
  }
  logger.log(`Acquired advisory lock ${keys.join(':')}`);

  try {
    return await task();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', keys);
    logger.log(`Released advisory lock ${keys.join(':')}`);
  }
}

module.exports = { withAdvisoryLock };
