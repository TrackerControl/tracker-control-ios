#!/usr/bin/env node

// Refreshes exodusTrackers.json from the Exodus Privacy API.
//
// The committed file is display data only: routes/index.js maps it by tracker
// name so views/form.pug can link a detected tracker to its Exodus report and
// show its category badges. Detection itself comes from the analyser's own
// signatures, so a stale file only ever costs a link and some badges.
//
// The API payload is normalised before writing: only the fields the views read
// are kept, categories and keys are sorted, and the file is pretty-printed.
// Exodus returns categories in an unstable order, so writing the raw response
// would produce ~90 meaningless entry changes per refresh and bury the real
// ones.
//
// Data is produced by Exodus Privacy (https://exodus-privacy.eu.org/) and
// distributed under their terms; this only mirrors their published output.

const fs = require('fs');
const path = require('path');

const EXODUS_URL = 'https://reports.exodus-privacy.eu.org/api/trackers';
const OUTPUT = 'exodusTrackers.json';
// Exodus ships a few hundred trackers; guard against a truncated response
// rather than trying to pin an exact count.
const MIN_TRACKERS = 100;
const FETCH_TIMEOUT_MS = 60000;

function parseArgs(argv) {
  const args = {
    url: EXODUS_URL,
    out: OUTPUT,
    input: null,
    summary: null,
    check: false
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--input') args.input = argv[++i];
    else if (arg === '--summary') args.summary = argv[++i];
    else if (arg === '--check') args.check = true;
    else if (arg === '--help') {
      console.log([
        'Usage: node scripts/update-exodus-trackers.js [options]',
        '',
        'Options:',
        '  --url <url>        API endpoint (default: the Exodus tracker API)',
        `  --out <path>       file to refresh (default: ${OUTPUT})`,
        '  --input <path>     read the payload from a file instead of the API',
        '  --summary <path>   write a Markdown summary of the changes',
        '  --check            validate and report, but never write',
        '',
        'Exit status:',
        '  0  up to date, refreshed, or validated',
        '  1  fetch or validation failed (the file is left untouched)'
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function fetchPayload(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'TrackerControl-updater' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
}

// Keeps only what views/form.pug reads (id, name, categories) and puts keys,
// entries and categories in a stable order, so a diff is all signal.
function normalise(raw) {
  let root;
  try {
    root = JSON.parse(raw);
  } catch (error) {
    throw new Error(`payload is not valid JSON: ${error.message}`);
  }

  if (!root || typeof root !== 'object' || Array.isArray(root) || !root.trackers)
    throw new Error("payload has no top-level 'trackers' object");

  const source = root.trackers;
  if (typeof source !== 'object' || Array.isArray(source) || !Object.keys(source).length)
    throw new Error("'trackers' is empty or not an object");

  const keys = Object.keys(source);
  if (keys.length < MIN_TRACKERS)
    throw new Error(`only ${keys.length} trackers (< ${MIN_TRACKERS}); response looks truncated`);

  const trackers = {};
  for (const key of keys.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))) {
    const entry = source[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`tracker '${key}' is not an object`);
    if (entry.id === undefined || entry.id === null)
      throw new Error(`tracker '${key}' is missing 'id'`);
    if (typeof entry.name !== 'string' || !entry.name)
      throw new Error(`tracker '${key}' is missing 'name'`);
    if (entry.categories !== undefined && !Array.isArray(entry.categories))
      throw new Error(`tracker '${key}' has a non-array 'categories'`);

    trackers[key] = {
      id: entry.id,
      name: entry.name,
      categories: [...(entry.categories || [])].sort()
    };
  }

  return { trackers };
}

function serialise(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function diff(before, after) {
  const old = (before && before.trackers) || {};
  const next = after.trackers;
  const added = [];
  const removed = [];
  const renamed = [];
  const recategorised = [];

  for (const [key, entry] of Object.entries(next)) {
    const previous = old[key];
    if (!previous) {
      added.push(entry);
      continue;
    }
    if (previous.name !== entry.name) renamed.push({ from: previous.name, to: entry.name });
    const wasCategories = [...(previous.categories || [])].sort();
    if (wasCategories.join('|') !== entry.categories.join('|'))
      recategorised.push({ name: entry.name, from: wasCategories, to: entry.categories });
  }
  for (const [key, entry] of Object.entries(old))
    if (!next[key]) removed.push(entry);

  return { added, removed, renamed, recategorised };
}

function changeCount(changes) {
  return changes.added.length + changes.removed.length + changes.renamed.length +
    changes.recategorised.length;
}

function summarise(changes, total) {
  const categories = (list) => (list.length ? list.join(', ') : 'none');
  const lines = [`Refreshed from the [Exodus Privacy tracker API](${EXODUS_URL}); ${total} trackers.`, ''];

  if (changes.added.length) {
    lines.push(`### Added (${changes.added.length})`, '');
    for (const entry of changes.added) lines.push(`- ${entry.name} — ${categories(entry.categories)}`);
    lines.push('');
  }
  if (changes.removed.length) {
    lines.push(`### Removed (${changes.removed.length})`, '');
    for (const entry of changes.removed) lines.push(`- ${entry.name}`);
    lines.push('');
  }
  if (changes.renamed.length) {
    lines.push(`### Renamed (${changes.renamed.length})`, '');
    for (const entry of changes.renamed) lines.push(`- ${entry.from} → ${entry.to}`);
    lines.push('');
  }
  if (changes.recategorised.length) {
    lines.push(`### Recategorised (${changes.recategorised.length})`, '');
    for (const entry of changes.recategorised)
      lines.push(`- ${entry.name}: ${categories(entry.from)} → ${categories(entry.to)}`);
    lines.push('');
  }

  lines.push(
    'Display data only — tracker detection comes from the analyser signatures, ' +
    'so this affects report page links and category badges.'
  );
  return `${lines.join('\n')}\n`;
}

function readExisting(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(`existing ${file} is not valid JSON: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  let raw;
  let source;
  try {
    if (args.input) {
      raw = fs.readFileSync(args.input, 'utf-8');
      source = args.input;
    } else {
      raw = await fetchPayload(args.url);
      source = args.url;
    }
  } catch (error) {
    console.error(`ERROR: could not obtain payload: ${error.message}`);
    return 1;
  }

  let data;
  try {
    data = normalise(raw);
  } catch (error) {
    console.error(`ERROR: validation failed: ${error.message}`);
    return 1;
  }

  const total = Object.keys(data.trackers).length;
  console.log(`Fetched from: ${source}`);
  console.log(`  trackers: ${total}`);

  const existing = readExisting(args.out);
  const changes = diff(existing, data);
  const serialised = serialise(data);
  const unchanged = existing !== null && serialise(existing) === serialised;

  if (changeCount(changes)) {
    console.log(`  added: ${changes.added.length}, removed: ${changes.removed.length}, ` +
      `renamed: ${changes.renamed.length}, recategorised: ${changes.recategorised.length}`);
  }
  if (args.summary && !unchanged)
    fs.writeFileSync(args.summary, summarise(changes, total));

  if (args.check) {
    console.log(unchanged
      ? `Validation OK; ${args.out} is up to date (--check: not written).`
      : `Validation OK; ${args.out} is out of date (--check: not written).`);
    return 0;
  }

  if (unchanged) {
    console.log(`Already up to date: ${args.out}`);
    return 0;
  }

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, serialised);
  console.log(`Updated: ${args.out}`);
  return 0;
}

module.exports = { normalise, serialise, diff, summarise, changeCount, EXODUS_URL };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
