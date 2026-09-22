'use strict';

// Neither metadata job runs a query that should take more than a moment, so a
// server-side statement timeout is the cheap guard against a run that blocks
// forever waiting on a lock. That matters because Railway does not terminate a
// deployment: a hung run leaves the cron service Active and every later firing
// is skipped, which looks exactly like a cron that was never scheduled.
//
// The timeout is a session parameter, so it constrains this job's own queries
// and nothing else — the web service's pool and the analyser's uploads keep
// whatever the server default gives them.
const DEFAULT_STATEMENT_TIMEOUT_MS = 30000;

function statementTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.METADATA_JOB_STATEMENT_TIMEOUT_MS, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_STATEMENT_TIMEOUT_MS;
}

// 0 disables the timeout, for an operator who needs a one-off long run.
function jobClientConfig(connectionString, env = process.env) {
  const timeout = statementTimeoutMs(env);
  return timeout > 0
    ? { connectionString, statement_timeout: timeout }
    : { connectionString };
}

module.exports = { DEFAULT_STATEMENT_TIMEOUT_MS, statementTimeoutMs, jobClientConfig };
