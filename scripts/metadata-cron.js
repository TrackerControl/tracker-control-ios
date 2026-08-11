#!/usr/bin/env node

'use strict';

const path = require('path');
const dotenv = require('dotenv');
const refresh = require('./refresh-app-store-metadata');
const prune = require('./prune-app-store-cache');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

function parseArgs(argv = process.argv.slice(2)) {
  const refreshArgs = [];
  const pruneArgs = [];

  for (const arg of argv) {
    if (arg === '--dry-run') {
      refreshArgs.push(arg);
      pruneArgs.push(arg);
    } else if (
      arg.startsWith('--limit=')
      || arg.startsWith('--min-age-days=')
      || arg.startsWith('--delay-ms=')
      || arg.startsWith('--country=')
    ) {
      refreshArgs.push(arg);
    } else if (arg.startsWith('--retention-days=') || arg.startsWith('--max-unreferenced=')) {
      pruneArgs.push(arg);
    } else if (arg === '--help') {
      console.log([
        'Usage: pnpm metadata-cron [refresh/prune options]',
        '',
        '  Refresh options: --limit=, --min-age-days=, --delay-ms=, --country=',
        '  Prune options:   --retention-days=, --max-unreferenced=',
        '  Shared option:   --dry-run'
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    refreshOptions: refresh.parseArgs(refreshArgs),
    pruneOptions: prune.parseArgs(pruneArgs)
  };
}

async function main({
  databaseUrl = process.env.DATABASE_URL,
  ClientClass,
  refreshOptions,
  pruneOptions,
  argv = process.argv.slice(2)
} = {}) {
  const parsed = parseArgs(argv);
  const refreshResult = await refresh.main({
    databaseUrl,
    ClientClass,
    options: refreshOptions || parsed.refreshOptions
  });
  const pruneResult = await prune.main({
    databaseUrl,
    ClientClass,
    options: pruneOptions || parsed.pruneOptions
  });
  return { refresh: refreshResult, prune: pruneResult };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
