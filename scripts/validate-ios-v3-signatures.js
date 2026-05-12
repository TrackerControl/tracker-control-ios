#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const args = {
    signatures: path.join('analyser', 'data', 'ios_signatures_v3.json'),
    metadata: path.join('analyser', 'data', 'ios_signatures_v3.metadata.json'),
    trackerscanDir: path.join('analyser', 'analysis-artifacts', 'trackerscan'),
    out: path.join('analyser', 'data', 'ios_signatures_v3.validation.json')
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--signatures') args.signatures = argv[++i];
    else if (arg === '--metadata') args.metadata = argv[++i];
    else if (arg === '--trackerscan-dir') args.trackerscanDir = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--help') {
      console.log([
        'Usage: node scripts/validate-ios-v3-signatures.js [options]',
        '',
        'Options:',
        '  --signatures <path>       v3 signatures JSON',
        '  --metadata <path>         v3 metadata JSON',
        '  --trackerscan-dir <path>  directory with *.trackerscan.json artifacts',
        '  --out <path>              validation JSON output'
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function compile(signature) {
  try {
    return new RegExp(signature.regex);
  } catch (error) {
    return null;
  }
}

function latestTrackerscanArtifacts(dir) {
  const latest = new Map();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.trackerscan.json')).sort()) {
    const match = file.match(/^(.+?)\.v(\d+)\.([^.]*)\.(\d{8}T\d{6}Z)\.trackerscan\.json$/);
    const bundleID = match ? match[1] : file.replace(/\.trackerscan\.json$/, '');
    const previous = latest.get(bundleID);
    if (!previous || file > previous.file) {
      latest.set(bundleID, { file, fullPath: path.join(dir, file) });
    }
  }
  return [...latest.values()];
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

function addExample(row, raw, classes) {
  if (row.examples.length >= 6) return;
  row.examples.push({
    bundleID: raw.bundleID,
    classes: classes.slice(0, 8),
    domains: (raw.trackingDomains || []).slice(0, 8)
  });
}

function countMatches(rawArtifacts, signatures, metadataByName) {
  const compiled = signatures.map((signature) => ({
    ...signature,
    metadata: metadataByName.get(signature.name) || {},
    rx: compile(signature)
  })).filter((signature) => signature.rx);
  const visible = compiled.filter((signature) => signature.exposure === 'visible');
  const hidden = compiled.filter((signature) => signature.exposure === 'hidden');
  const promoted = new Set([...metadataByName.values()].filter((signature) => signature.curation_decision === 'promote').map((signature) => signature.name));
  const refined = new Set([...metadataByName.values()].filter((signature) => signature.curation_decision === 'merge-refinement').map((signature) => signature.name));
  const stats = new Map();
  const hiddenStats = new Map();
  let appsWithFullClasses = 0;

  const domainStats = new Map();
  for (const signature of signatures) {
    const domains = signature.metadata?.curation_evidence?.top_domains || [];
    if (!domains.length) continue;
    domainStats.set(signature.name, {
      owner: signature.name,
      domains,
      domainApps: 0,
      v3VisibleApps: 0,
      examples: []
    });
  }
  if (!domainStats.has('AppMetrica')) {
    domainStats.set('AppMetrica', {
      owner: 'AppMetrica',
      domains: ['appmetrica.yandex'],
      domainApps: 0,
      v3VisibleApps: 0,
      examples: []
    });
  }

  for (const artifact of rawArtifacts) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(artifact.fullPath, 'utf8'));
    } catch {
      continue;
    }
    const allClasses = (raw.matches || []).find((match) => match.name === '__ALL_CLASSES__' && Array.isArray(match.classes));
    if (!allClasses) continue;
    appsWithFullClasses++;

    const classes = [...new Set(allClasses.classes)].sort();
    const visibleNames = new Set();
    const domains = (raw.trackingDomains || []).map((domain) => String(domain).toLowerCase());

    for (const signature of visible) {
      const matches = classes.filter((className) => signature.rx.test(className));
      if (!matches.length) continue;
      visibleNames.add(signature.name);
      const row = stats.get(signature.name) || { name: signature.name, apps: 0, matches: 0, examples: [] };
      row.apps++;
      row.matches += matches.length;
      addExample(row, raw, matches);
      stats.set(signature.name, row);
    }

    for (const signature of hidden) {
      const matches = classes.filter((className) => signature.rx.test(className));
      if (!matches.length) continue;
      const row = hiddenStats.get(signature.name) || { name: signature.name, hiddenMatchedApps: 0, visibleMatchedApps: 0, examples: [] };
      row.hiddenMatchedApps++;
      if (visibleNames.has(signature.name)) row.visibleMatchedApps++;
      addExample(row, raw, matches);
      hiddenStats.set(signature.name, row);
    }

    for (const row of domainStats.values()) {
      const hasDomain = domains.some((domain) => row.domains.some((needle) => domain.includes(needle)));
      if (!hasDomain) continue;
      row.domainApps++;
      if (visibleNames.has(row.owner)) {
        row.v3VisibleApps++;
      } else if (row.examples.length < 8) {
        row.examples.push({
          bundleID: raw.bundleID,
          domains: domains.filter((domain) => row.domains.some((needle) => domain.includes(needle))).slice(0, 8),
          visible: [...visibleNames].sort()
        });
      }
    }
  }

  const pick = (names) => names.map((name) => stats.get(name) || { name, apps: 0, matches: 0, examples: [] });
  return {
    appsWithFullClasses,
    visible,
    hidden,
    promoted,
    refined,
    promotedStats: pick([...promoted].sort()),
    refinedStats: pick([...refined].sort()),
    domainStats: Object.fromEntries([...domainStats.entries()]),
    hiddenStats: [...hiddenStats.values()].sort((a, b) => b.hiddenMatchedApps - a.hiddenMatchedApps || a.name.localeCompare(b.name))
  };
}

function main() {
  const args = parseArgs(process.argv);
  const signatures = JSON.parse(fs.readFileSync(args.signatures, 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(args.metadata, 'utf8'));
  const metadataByName = new Map((metadata.signatures || []).map((signature) => [signature.name, signature]));
  const rawArtifacts = latestTrackerscanArtifacts(args.trackerscanDir);
  const result = countMatches(rawArtifacts, signatures, metadataByName);
  const out = {
    generated_at: new Date().toISOString(),
    latest_raw_trackerscan_artifacts: rawArtifacts.length,
    apps_with_full_classes: result.appsWithFullClasses,
    signature_file: args.signatures,
    signature_matching_rules_sha256: matchingRulesHash(signatures),
    trackerscan_dir: args.trackerscanDir,
    visible_signature_count: result.visible.length,
    hidden_signature_count: result.hidden.length,
    promoted_signatures: [...result.promoted].sort(),
    refined_legacy_signatures: [...result.refined].sort(),
    promoted_stats: result.promotedStats,
    refined_stats: result.refinedStats,
    domain_cross_validation: result.domainStats,
    hidden_control_stats: result.hiddenStats,
    hidden_noisy_control_stats: result.hiddenStats
  };
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Validated ${result.appsWithFullClasses} full class dumps from ${rawArtifacts.length} latest artifacts.`);
  console.log(`Wrote ${args.out}`);
}

main();
