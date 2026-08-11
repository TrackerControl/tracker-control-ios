'use strict';

async function withAdvisoryLock(client, keys, task, logger = console) {
  logger.log(`Waiting for advisory lock ${keys.join(':')}`);
  await client.query('SELECT pg_advisory_lock($1, $2)', keys);
  logger.log(`Acquired advisory lock ${keys.join(':')}`);

  try {
    return await task();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', keys);
    logger.log(`Released advisory lock ${keys.join(':')}`);
  }
}

module.exports = { withAdvisoryLock };
