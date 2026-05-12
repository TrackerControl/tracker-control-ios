#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.join(__dirname, '..');
const paths = {
  signatures: path.join(repoRoot, 'analyser', 'data', 'ios_signatures_v3.json'),
  metadata: path.join(repoRoot, 'analyser', 'data', 'ios_signatures_v3.metadata.json'),
  summary: path.join(repoRoot, 'analyser', 'data', 'ios_signatures_v3.summary.json'),
  validation: path.join(repoRoot, 'analyser', 'data', 'ios_signatures_v3.validation.json'),
  docs: path.join(repoRoot, 'docs', 'ios-v3-signature-validation.md')
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(errors, message) {
  errors.push(message);
}

function countBy(signatures, exposure) {
  return signatures.filter((signature) => signature.exposure === exposure).length;
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

function main() {
  const errors = [];
  for (const [name, file] of Object.entries(paths)) {
    if (!fs.existsSync(file)) fail(errors, `Missing ${name}: ${path.relative(repoRoot, file)}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));

  const signatures = readJson(paths.signatures);
  const metadata = readJson(paths.metadata);
  const summary = readJson(paths.summary);
  const validation = readJson(paths.validation);
  const docs = fs.readFileSync(paths.docs, 'utf8');
  const serializedV3 = JSON.stringify({ signatures, metadata, summary });

  const allowedExposure = new Set(['visible', 'hidden', 'non-tracker', 'instrumentation']);
  const promotedOrRefined = [...summary.promoted_new_signatures, ...summary.refined_legacy_signatures];

  if (summary.signature_count !== signatures.length) fail(errors, 'summary.signature_count does not match signature file length');
  if (metadata.signature_count !== signatures.length) fail(errors, 'metadata.signature_count does not match signature file length');
  if (!Array.isArray(metadata.signatures)) fail(errors, 'metadata.signatures is not an array');
  if (summary.visible_count !== countBy(signatures, 'visible')) fail(errors, 'summary.visible_count does not match visible signatures');
  if (summary.hidden_count !== countBy(signatures, 'hidden')) fail(errors, 'summary.hidden_count does not match hidden signatures');
  if (summary.non_tracker_count !== countBy(signatures, 'non-tracker')) fail(errors, 'summary.non_tracker_count does not match non-tracker signatures');
  if (summary.instrumentation_count !== countBy(signatures, 'instrumentation')) fail(errors, 'summary.instrumentation_count does not match instrumentation signatures');

  for (const signature of signatures) {
    if (!signature.id && signature.id !== 0) fail(errors, `Missing id for ${signature.name}`);
    if (!signature.name) fail(errors, `Missing name for id ${signature.id}`);
    if (!signature.regex) fail(errors, `Missing regex for ${signature.name}`);
    if (signature.signature_version !== 3) fail(errors, `Missing/invalid signature_version for ${signature.name}`);
    if (!allowedExposure.has(signature.exposure)) fail(errors, `Missing/invalid exposure for ${signature.name}`);
    for (const key of ['comment', 'validation', 'evidence', 'curation_tier', 'curation_decision', 'curation_notes', 'curation_evidence', 'semantic_validation']) {
      if (Object.prototype.hasOwnProperty.call(signature, key)) fail(errors, `Runtime signature contains metadata field ${key}: ${signature.name}`);
    }
  }

  const metadataByName = new Map((metadata.signatures || []).map((signature) => [signature.name, signature]));
  for (const signature of signatures) {
    const info = metadataByName.get(signature.name);
    if (!info) fail(errors, `Missing metadata for ${signature.name}`);
    if (info && info.exposure !== signature.exposure) fail(errors, `Metadata exposure mismatch for ${signature.name}`);
  }

  for (const removed of summary.removed_duplicate_refinements || []) {
    if (signatures.some((signature) => signature.name === removed)) fail(errors, `Removed v2 refinement still present: ${removed}`);
  }
  const duplicateNames = [...signatures.reduce((counts, signature) => counts.set(signature.name, (counts.get(signature.name) || 0) + 1), new Map())]
    .filter(([, count]) => count > 1);
  if (duplicateNames.length) fail(errors, `Duplicate visible/signature names remain: ${duplicateNames.map(([name, count]) => `${name} (${count})`).join(', ')}`);

  for (const name of promotedOrRefined) {
    const signature = signatures.find((candidate) => candidate.name === name);
    const validationInfo = metadataByName.get(name)?.semantic_validation;
    if (!signature) fail(errors, `Promoted/refined signature missing from v3: ${name}`);
    if (!validationInfo) fail(errors, `Missing automated semantic_validation for ${name}`);
    if (validationInfo && (!validationInfo.confidence || !validationInfo.risk || !validationInfo.notes)) fail(errors, `Incomplete semantic_validation for ${name}`);
    if (validationInfo && (!Array.isArray(validationInfo.validated_classes) || !validationInfo.validated_classes.length)) fail(errors, `Missing validated_classes for ${name}`);
  }

  if (serializedV3.includes('semantic_review') || serializedV3.includes('reviewed_classes')) {
    fail(errors, 'Generated v3 data still contains old review terminology');
  }
  if (/human review|manual review|pending review|Needs manual|Candidate for promotion/i.test(docs)) {
    fail(errors, 'Docs still imply human/manual review flow');
  }

  if (!Array.isArray(summary.provenance?.v2_source_branches) || !summary.provenance.v2_source_branches.includes('ios-v2-analyser') || !summary.provenance.v2_source_branches.includes('ios-class-evidence-refactor')) {
    fail(errors, 'Provenance must name both ios-v2-analyser and ios-class-evidence-refactor');
  }
  if (!summary.runtime_scope || !summary.runtime_scope.includes('offline')) fail(errors, 'Summary must state offline/runtime scope');

  const validationNames = new Set([
    ...validation.promoted_stats.map((row) => row.name),
    ...validation.refined_stats.map((row) => row.name)
  ]);
  for (const name of promotedOrRefined) {
    if (!validationNames.has(name)) fail(errors, `Validation output has no stats for ${name}`);
  }
  if (validation.apps_with_full_classes < 800) fail(errors, `Validation class-dump coverage too low: ${validation.apps_with_full_classes}`);
  if (validation.latest_raw_trackerscan_artifacts < validation.apps_with_full_classes) fail(errors, 'Raw artifact count is smaller than full class dump count');
  if (validation.signature_matching_rules_sha256 !== matchingRulesHash(signatures)) fail(errors, 'Validation output does not match the current v3 matching rules hash');

  for (const name of promotedOrRefined) {
    if (!docs.includes(name)) fail(errors, `Docs do not mention promoted/refined signature: ${name}`);
  }
  for (const required of ['Promotion Rules', 'Known Caveats', 'Domain Cross-Validation', 'Important Negative Controls', 'exposure === "visible"']) {
    if (!docs.includes(required)) fail(errors, `Docs missing required section/text: ${required}`);
  }

  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    signatures: signatures.length,
    visible: countBy(signatures, 'visible'),
    hidden: countBy(signatures, 'hidden'),
    non_tracker: countBy(signatures, 'non-tracker'),
    instrumentation: countBy(signatures, 'instrumentation'),
    validation_class_dumps: validation.apps_with_full_classes,
    promoted: summary.promoted_new_signatures,
    refined: summary.refined_legacy_signatures
  }, null, 2));
}

main();
