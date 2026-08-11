#!/usr/bin/env node

'use strict';

const path = require('path');
const dotenv = require('dotenv');
const refresh = require('./refresh-app-store-metadata');
const prune = require('./prune-app-store-cache');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

async function main({
  databaseUrl = process.env.DATABASE_URL,
  ClientClass,
  refreshOptions,
  pruneOptions
} = {}) {
  const refreshResult = await refresh.main({
    databaseUrl,
    ClientClass,
    options: refreshOptions || refresh.parseArgs([])
  });
  const pruneResult = await prune.main({
    databaseUrl,
    ClientClass,
    options: pruneOptions || prune.parseArgs([])
  });
  return { refresh: refreshResult, prune: pruneResult };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
