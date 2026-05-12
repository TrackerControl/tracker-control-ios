#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { Client } = require('pg');
const companies = require('../lib/iosTrackerCompanies');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'analyser', '.env') });

const nonTrackers = new Set([
  'Twitter Account Kit',
  'Google Firebase',
  'Get device information',
  'AdID access',
  'Google Firebase Messaging',
  'Google Consent API',
  'YouTube',
  'Google Sign-In',
  'Google Maps',
  'Amazon AWS',
  'iAd'
]);

function parseArgs(argv) {
  const args = {
    signatures: null,
    trackerscanDir: path.join('analyser', 'analysis-artifacts', 'trackerscan'),
    analysisVersion: null,
    apply: false,
    appIds: []
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--signatures') args.signatures = argv[++i];
    else if (arg === '--trackerscan-dir') args.trackerscanDir = argv[++i];
    else if (arg === '--analysis-version') args.analysisVersion = parseInt(argv[++i], 10);
    else if (arg === '--appid') args.appIds.push(argv[++i]);
    else if (arg.startsWith('--appid=')) args.appIds.push(arg.slice('--appid='.length));
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--help') {
      console.log([
        'Usage: node scripts/replay-ios-signatures.js [options]',
        '',
        'Options:',
        '  --signatures <path>         Signature JSON file to replay',
        '  --trackerscan-dir <path>    Directory with *.trackerscan.json artifacts',
        '  --analysis-version <number> Override version to write on --apply',
        '  --appid <bundle id>         Limit to one app; repeatable',
        '  --apply                     Update apps.analysis; dry-run by default'
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.signatures) {
    throw new Error('--signatures is required');
  }

  return args;
}

function canonicalTrackerName(name) {
  return String(name || '').replace(/\s+-\s+v2 refined$/, '');
}

function compile(signature) {
  try {
    return new RegExp(signature.regex);
  } catch {
    return null;
  }
}

function normalizeSignature(signature) {
  return {
    ...signature,
    exposure: signature.exposure || null
  };
}

function loadVisibleSignatures(signaturePath) {
  const parsed = JSON.parse(fs.readFileSync(signaturePath, 'utf8'));
  const signatures = Array.isArray(parsed) ? parsed : (parsed.trackers || []);
  return signatures
    .map(normalizeSignature)
    .filter((signature) => signature.exposure === 'visible')
    .map((signature) => ({ ...signature, rx: compile(signature) }))
    .filter((signature) => signature.rx);
}

function matchingRulesHash(signatures) {
  const rules = signatures
    .map((signature) => ({
      id: signature.id,
      name: signature.name,
      regex: signature.regex,
      exposure: signature.exposure
    }))
    .sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));
  return crypto.createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

function signatureSetFromPath(signaturePath) {
  return path.basename(signaturePath, path.extname(signaturePath));
}

function latestTrackerscanArtifacts(dir) {
  const latest = new Map();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.trackerscan.json')).sort()) {
    const match = file.match(/^(.+?)\.v(\d+)\.([^.]*)\.(\d{8}T\d{6}Z)\.trackerscan\.json$/);
    const bundleID = match ? match[1] : file.replace(/\.trackerscan\.json$/, '');
    const previous = latest.get(bundleID);
    if (!previous || file > previous.file) {
      latest.set(bundleID, { bundleID, file, fullPath: path.join(dir, file) });
    }
  }
  return [...latest.values()];
}

function fullClassesFromRaw(raw) {
  const allClasses = (raw.matches || []).find((match) =>
    match && match.name === '__ALL_CLASSES__' && Array.isArray(match.classes)
  );
  if (!allClasses) return null;
  return [...new Set(allClasses.classes.map(String))].sort();
}

function compactRawTrackerscan(raw) {
  if (!raw || !Array.isArray(raw.matches)) return raw;
  return {
    ...raw,
    matches: raw.matches.map((match) => {
      if (!match || match.name !== '__ALL_CLASSES__' || !Array.isArray(match.classes)) return match;
      const compact = { ...match };
      delete compact.classes;
      compact.class_count = match.classes.length;
      compact.class_examples = match.classes.slice(0, 50);
      return compact;
    })
  };
}

function replayRawTrackerscan(raw, signatures, options = {}) {
  const classes = fullClassesFromRaw(raw);
  if (!classes) return null;

  const trackers = {};
  const non_trackers = {};
  const tracker_details = [];

  for (const rawSignature of signatures) {
    const signature = normalizeSignature(rawSignature);
    if (signature.exposure && signature.exposure !== 'visible') continue;
    const matches = classes.filter((className) => signature.rx.test(className));
    if (!matches.length) continue;

    const canonicalName = canonicalTrackerName(signature.name);
    const detail = {
      id: signature.id,
      name: signature.name,
      canonical_name: canonicalName,
      classes: matches,
      sources: ['signature-replay']
    };

    if (nonTrackers.has(canonicalName)) {
      non_trackers[signature.name] = true;
    } else {
      trackers[canonicalName] = companies[canonicalName] || companies[signature.name] || canonicalName;
      tracker_details.push(detail);
    }
  }

  const existing = options.existingAnalysis || {};
  const analysisVersion = options.analysisVersion ?? existing.analysis_version ?? null;

  const result = {
    success: true,
    analysis_source: 'signature-replay',
    analysis_version: analysisVersion,
    signature_set: options.signatureSet || signatureSetFromPath(options.signaturePath || ''),
    signature_path: options.signaturePath || null,
    signature_matching_rules_sha256: options.signatureHash || null,
    evidence_captured_at: options.evidenceCapturedAt || null,
    bundleID: raw.bundleID || existing.bundleID || null,
    version: raw.version || existing.version || null,
    trackers,
    non_trackers,
    permissions: existing.permissions || raw.permissions || [],
    tracker_details,
    trackingDomains: raw.trackingDomains || existing.trackingDomains || [],
    privacyTracking: Boolean(raw.privacyTracking ?? existing.privacyTracking),
    privacyManifests: raw.privacyManifests ?? existing.privacyManifests ?? 0,
    classCount: raw.classCount ?? classes.length,
    scannedImages: raw.scannedImages ?? existing.scannedImages ?? 0,
    candidateImages: raw.candidateImages ?? existing.candidateImages ?? 0,
    appexCount: raw.appexCount ?? existing.appexCount ?? 0,
    appexScanned: raw.appexScanned ?? existing.appexScanned ?? 0,
    raw_info_plist_path: existing.raw_info_plist_path || null,
    raw_info_plist: existing.raw_info_plist || null,
    raw_appex_info_plists: existing.raw_appex_info_plists || [],
    raw_trackerscan: compactRawTrackerscan(raw)
  };

  if (raw.runtimeError || existing.runtimeError) result.runtimeError = raw.runtimeError || existing.runtimeError;
  if (raw.encryptedBinaries || existing.encryptedBinaries) result.encryptedBinaries = raw.encryptedBinaries || existing.encryptedBinaries;

  return result;
}

function diffTrackers(currentAnalysis, replayedAnalysis) {
  const before = new Set(Object.keys(currentAnalysis?.trackers || {}));
  const after = new Set(Object.keys(replayedAnalysis?.trackers || {}));
  return {
    added: [...after].filter((name) => !before.has(name)).sort(),
    removed: [...before].filter((name) => !after.has(name)).sort(),
    unchanged: [...after].filter((name) => before.has(name)).sort()
  };
}

async function fetchCurrentAnalyses(appIds) {
  if (!process.env.DATABASE_URL) return new Map();

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const params = [];
    let where = '';
    if (appIds.length) {
      params.push(appIds);
      where = 'WHERE appid = ANY($1)';
    }
    const result = await client.query(`SELECT appid, analysis, analysisversion FROM apps ${where}`, params);
    return new Map(result.rows.map((row) => [row.appid, {
      analysis: row.analysis,
      analysisversion: row.analysisversion
    }]));
  } finally {
    await client.end();
  }
}

async function applyReplay(rows) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required with --apply');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let inTransaction = false;
  try {
    const history = await client.query("SELECT to_regclass('public.app_analyses') AS table_name");
    if (!history.rows[0].table_name) {
      throw new Error('app_analyses does not exist. Run npm run migrate before applying replay.');
    }

    await client.query('BEGIN');
    inTransaction = true;
    for (const row of rows) {
      await client.query(`
        INSERT INTO app_analyses (
          appid,
          analysis,
          analysisversion,
          analysed,
          app_version,
          app_store_updated,
          analysis_source,
          success
        )
        SELECT
          appid,
          analysis,
          analysisversion,
          COALESCE(analysed, NOW()),
          details->>'version',
          NULLIF(details->>'updated', '')::timestamp,
          COALESCE(analysis->>'analysis_source', 'legacy'),
          COALESCE((analysis->>'success')::boolean, true)
        FROM apps
        WHERE appid = $1
          AND analysis IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM app_analyses existing
            WHERE existing.appid = apps.appid
              AND existing.analysed = COALESCE(apps.analysed, NOW())
          )
      `, [row.bundleID]);

      await client.query(
        'UPDATE apps SET analysis = $1, analysisversion = $2, analysed = NOW() WHERE appid = $3',
        [row.analysis, row.analysisVersion, row.bundleID]
      );
    }
    await client.query('COMMIT');
    inTransaction = false;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const wanted = new Set(args.appIds);
  const signatures = loadVisibleSignatures(args.signatures);
  const signatureHash = matchingRulesHash(signatures);
  const artifacts = latestTrackerscanArtifacts(args.trackerscanDir)
    .filter((artifact) => wanted.size === 0 || wanted.has(artifact.bundleID));
  const existing = await fetchCurrentAnalyses(args.appIds);

  const rows = [];
  const skipped = [];
  for (const artifact of artifacts) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(artifact.fullPath, 'utf8'));
    } catch {
      skipped.push({ bundleID: artifact.bundleID, reason: 'invalid_json' });
      continue;
    }

    const analysis = replayRawTrackerscan(raw, signatures, {
      existingAnalysis: existing.get(artifact.bundleID)?.analysis,
      analysisVersion: args.analysisVersion ?? existing.get(artifact.bundleID)?.analysisversion ?? null,
      signaturePath: args.signatures,
      signatureHash,
      evidenceCapturedAt: artifact.file.match(/\.(\d{8}T\d{6}Z)\.trackerscan\.json$/)?.[1] || null
    });
    if (!analysis) {
      skipped.push({ bundleID: artifact.bundleID, reason: 'missing_full_classes' });
      continue;
    }

    rows.push({
      bundleID: artifact.bundleID,
      file: artifact.file,
      analysis,
      analysisVersion: args.analysisVersion ?? existing.get(artifact.bundleID)?.analysisversion ?? null,
      diff: diffTrackers(existing.get(artifact.bundleID)?.analysis, analysis)
    });
  }

  const changed = rows.filter((row) => row.diff.added.length || row.diff.removed.length);
  console.log(`${args.apply ? 'Applying' : 'Dry run:'} ${rows.length} replayed analyses from ${artifacts.length} artifacts; skipped ${skipped.length}.`);
  console.log(`${changed.length} apps have tracker changes.`);
  for (const row of changed.slice(0, 25)) {
    console.log(`${row.bundleID}: +${row.diff.added.join(',') || '-'} -${row.diff.removed.join(',') || '-'}`);
  }
  if (changed.length > 25) console.log(`... ${changed.length - 25} more changed apps omitted.`);

  if (args.apply) {
    await applyReplay(rows);
    const versionLabel = Number.isInteger(args.analysisVersion)
      ? `analysis version ${args.analysisVersion}`
      : 'their existing analysis versions';
    console.log(`Updated ${rows.length} apps to ${versionLabel}.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  diffTrackers,
  fullClassesFromRaw,
  latestTrackerscanArtifacts,
  loadVisibleSignatures,
  replayRawTrackerscan
};
