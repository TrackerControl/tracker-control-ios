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
