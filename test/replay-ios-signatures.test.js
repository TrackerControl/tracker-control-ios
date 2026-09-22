const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const replay = require('../scripts/replay-ios-signatures');

test('replays visible signatures from full class evidence', () => {
  const raw = {
    bundleID: 'com.example.app',
    version: '1.2.3',
    classCount: 3,
    trackingDomains: ['example.com'],
    privacyTracking: true,
    privacyManifests: 1,
    matches: [
      { id: 999, name: '__ALL_CLASSES__', classes: ['NoiseClass', 'RollbarNotifier', 'UXCamBridge'] }
    ]
  };
  const signatures = [
    { id: 1, name: 'Rollbar', regex: '^Rollbar', exposure: 'visible', rx: /^Rollbar/ },
    { id: 2, name: 'UXCam', regex: '^UXCam', exposure: 'visible', rx: /^UXCam/ },
    { id: 3, name: 'Hidden', regex: '^Noise', exposure: 'hidden', rx: /^Noise/ }
  ];

  const analysis = replay.replayRawTrackerscan(raw, signatures, {
    existingAnalysis: { permissions: ['Camera'] },
    analysisVersion: 5
  });

  assert.deepEqual(Object.keys(analysis.trackers).sort(), ['Rollbar', 'UXCam']);
  assert.equal(analysis.trackers.Rollbar, 'Rollbar');
  assert.equal(analysis.analysis_source, 'signature-replay');
  assert.equal(analysis.analysis_version, 5);
  assert.deepEqual(analysis.permissions, ['Camera']);
  assert.equal(analysis.raw_trackerscan.matches[0].class_count, 3);
  assert.equal(analysis.raw_trackerscan.matches[0].classes, undefined);
});

test('skips artifacts without full __ALL_CLASSES__ evidence', () => {
  assert.equal(replay.replayRawTrackerscan({ matches: [] }, []), null);
  assert.equal(replay.replayRawTrackerscan({
    matches: [{ id: 999, name: '__ALL_CLASSES__', class_count: 2 }]
  }, []), null);
});

test('selects newest trackerscan artifact per bundle id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-artifacts-'));
  try {
    fs.writeFileSync(path.join(dir, 'com.example.app.v4.ios-v2.20260101T000000Z.trackerscan.json'), '{}');
    fs.writeFileSync(path.join(dir, 'com.example.app.v4.ios-v2.20260102T000000Z.trackerscan.json'), '{}');
    fs.writeFileSync(path.join(dir, 'com.other.app.v4.ios-v2.20260101T000000Z.trackerscan.json'), '{}');

    const artifacts = replay.latestTrackerscanArtifacts(dir).sort((a, b) => a.bundleID.localeCompare(b.bundleID));
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0].bundleID, 'com.example.app');
    assert.equal(artifacts[0].file, 'com.example.app.v4.ios-v2.20260102T000000Z.trackerscan.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trackerscan converter exposes only visible v3 signatures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trackerscan-convert-'));
  try {
    const rawPath = path.join(dir, 'raw.json');
    const outPath = path.join(dir, 'analysis.json');
    const signaturesPath = path.join(dir, 'signatures.json');

    fs.writeFileSync(rawPath, JSON.stringify({
      bundleID: 'com.example.app',
      matches: [
        { id: 1, name: 'Rollbar', classes: ['RollbarNotifier'], sources: ['static'] },
        { id: 2, name: 'HiddenControl', classes: ['HiddenControlClass'], sources: ['static'] }
      ]
    }));
    fs.writeFileSync(signaturesPath, JSON.stringify([
      { id: 1, name: 'Rollbar', regex: '^Rollbar', exposure: 'visible' },
      { id: 2, name: 'HiddenControl', regex: '^HiddenControl', exposure: 'hidden' }
    ]));

    execFileSync(process.execPath, [
      path.join(__dirname, '..', 'analyser', 'trackerscan_to_analysis.js'),
      'com.example.app',
      rawPath,
      outPath,
      '',
      'ios-v3',
      signaturesPath,
      '4'
    ]);

    const analysis = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.deepEqual(Object.keys(analysis.trackers), ['Rollbar']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applying a successful replay synchronizes scheduling state', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/to_regclass/.test(sql)) return { rows: [{ table_name: 'app_analyses' }] };
      return { rowCount: 1, rows: [] };
    }
  };

  await replay.applyReplayRows(client, [{
    bundleID: 'com.example.app',
    analysis: { success: true, trackers: {} },
    analysisVersion: 4
  }]);

  const update = queries.find(({ sql }) => /UPDATE apps/.test(sql));
  assert.ok(update);
  assert.match(update.sql, /status = 'analysed'/);
  assert.match(update.sql, /processing_started = NULL/);
  assert.match(update.sql, /analysis_claim_token = NULL/);
  assert.match(update.sql, /failure_reason = NULL/);
  assert.match(update.sql, /failure_retryable = NULL/);
  assert.deepEqual(update.params, [
    { success: true, trackers: {} },
    4,
    'com.example.app'
  ]);
});

test('replay records the new analysis in app_analyses after the UPDATE', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/to_regclass/.test(sql)) return { rows: [{ table_name: 'app_analyses' }] };
      return { rowCount: 1, rows: [] };
    }
  };

  await replay.applyReplayRows(client, [{
    bundleID: 'com.example.app',
    analysis: { success: true, trackers: {} },
    analysisVersion: 4
  }]);

  const inserts = queries.filter(({ sql }) => /INSERT INTO app_analyses/.test(sql));
  assert.equal(inserts.length, 2, 'expected a pre-UPDATE snapshot insert and a post-UPDATE new-analysis insert');

  const updateIndex = queries.findIndex(({ sql }) => /UPDATE apps/.test(sql));
  const postUpdateInsertIndex = queries.findIndex(
    ({ sql }, index) => index > updateIndex && /INSERT INTO app_analyses/.test(sql)
  );
  assert.ok(postUpdateInsertIndex > updateIndex, 'the new-analysis insert must run after the UPDATE commits');

  const postUpdateInsert = queries[postUpdateInsertIndex];
  // The new row's analysed must be sourced from apps.analysed in SQL (read
  // back after the UPDATE stamped it with NOW() in the same transaction),
  // never bound as a JS parameter -- the same microsecond-precision reason
  // as updateAnalysisWithClient in models/Apps.js.
  assert.match(postUpdateInsert.sql, /SELECT\s+\$1,\s*\$2,\s*\$3,\s*apps\.analysed,/);
  assert.deepEqual(postUpdateInsert.params, [
    'com.example.app',
    { success: true, trackers: {} },
    4
  ]);
});

test('replay snapshot falls back to apps.added, not NOW(), to avoid colliding with the new analysis row', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/to_regclass/.test(sql)) return { rows: [{ table_name: 'app_analyses' }] };
      return { rowCount: 1, rows: [] };
    }
  };

  await replay.applyReplayRows(client, [{
    bundleID: 'com.example.app',
    analysis: { success: true, trackers: {} },
    analysisVersion: 4
  }]);

  const snapshotInsert = queries.find(({ sql }) =>
    /INSERT INTO app_analyses/.test(sql) && /COALESCE\(analysed, added\)/.test(sql)
  );
  assert.ok(snapshotInsert, 'expected the pre-UPDATE snapshot to fall back to apps.added');
  assert.match(snapshotInsert.sql, /existing\.analysed = COALESCE\(apps\.analysed, apps\.added\)/);
  assert.doesNotMatch(snapshotInsert.sql, /COALESCE\(analysed, NOW\(\)\)/);
});
