#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const [, , appId, rawPath, outPath, ipaPath, signatureSetArg, signaturePathArg, analysisVersionArg] = process.argv;

if (!appId || !rawPath || !outPath) {
  console.error('Usage: trackerscan_to_analysis.js <appId> <raw-json> <analysis-json> [ipa] [signature-set] [signature-path] [analysis-version]');
  process.exit(2);
}

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

function isInstrumentationSignature(name) {
  return /^__.+__$/.test(name);
}

function canonicalTrackerName(name) {
  return String(name || '').replace(/\s+-\s+v2 refined$/, '');
}

const companies = {
  'Google AdMob': 'AdMob',
  'Facebook': 'Facebook',
  'Google CrashLytics': 'Crashlytics',
  'Google Analytics': 'Google Analytics',
  Inmobi: 'InMobi',
  'Unity3d Ads': 'Unity Technologies',
  Moat: 'Moat',
  'Twitter MoPub': 'MoPub',
  'AppLovin (MAX and SparkLabs)': 'AppLovin',
  ChartBoost: 'Chartboost',
  AdColony: 'AdColony',
  'Amazon Analytics (Amazon insights)': 'Amazon Analytics',
  HockeyApp: 'Bit Stadium',
  Tapjoy: 'Tapjoy',
  Branch: 'Branch',
  'Microsoft Visual Studio App Center': 'App Center',
  'Adobe Experience Cloud': 'Adobe Experience Cloud',
  MixPanel: 'Mixpanel',
  Adjust: 'Adjust',
  Amplitude: 'Amplitude',
  'Heyzap (bought by Fyber)': 'Heyzap',
  'Amazon Advertisement': 'Amazon Advertising',
  Vungle: 'Vungle',
  AppsFlyer: 'AppsFlyer',
  WeChat: 'Tencent',
  Baidu: 'Baidu',
  'Umeng+': 'Umeng+',
  'JiGuang Aurora Mobile JPush': 'JPush',
  'Tencent MTA': 'Tencent',
  Bugly: 'Tencent',
  'Tencent Map LBS': 'Tencent',
  'WeChat Location': 'Tencent',
  ironSource: 'ironSource',
  Startapp: 'StartApp',
  'Google Tag Manager': 'Google Tag Manager',
  Pollfish: 'Pollfish',
  Nexage: 'NEXAGE',
  Flurry: 'Flurry',
  'Verizon Ads': 'Verizon Media',
  Revmob: 'RevMob',
  'New Relic': 'New Relic',
  'Supersonic Ads': 'Supersonic Studios',
  Appodeal: 'Appodeal',
  Fyber: 'Fyber',
  Smaato: 'Smaato',
  Urbanairship: 'Airship',
  MobFox: 'Mobfox',
  Localytics: 'Localytics',
  'Appcelerator Analytics': 'Appcelerator',
  AdBuddiz: 'AdBuddiz',
  'Radius Networks': 'Radius Networks',
  ComScore: 'comScore',
  Soomla: 'Soomla',
  BugSense: 'BugSense',
  'Yandex Ad': 'Yandex',
  'Mail.ru': 'Mail.ru',
  Quantcast: 'Quantcast',
  'VKontakte SDK': 'VKontakte',
  Batch: 'Batch',
  Tapdaq: 'Tapdaq',
  'Fyber SponsorPay': 'Fyber',
  Ooyala: 'Ooyala - Flex Media Platform',
  'Google Firebase Analytics': 'Firebase',
  'AdTech Mobile SDK': 'AdTech',
  PlayHaven: 'PlayHaven',
  WeiboSDK: 'Weibo',
  SKAdNetwork: 'Apple',
  CleverTap: 'CleverTap',
  'Braze (formerly Appboy)': 'Braze',
  Bugsnag: 'Bugsnag',
  myTarget: 'My.com',
  Tencent: 'Tencent',
  'Tencent Ads': 'Tencent',
  Kochava: 'Kochava',
  Mintegral: 'Mintegral',
  Pangle: 'Pangle',
  AppMetrica: 'Yandex',
  'Google Play Services': 'Google',
  Alipay: 'Alibaba',
  'Baidu Map': 'Baidu',
  'Baidu Mobile Stat': 'Baidu',
  'Baidu Mobile Ads': 'Baidu',
  'Umeng Analytics': 'Umeng+',
  'Umeng Social': 'Umeng+',
  'Mob.com': 'MobTech',
  'Alibaba Cloud Utils': 'Alibaba',
  'Alibaba Cloud Push': 'Alibaba',
  'Alibaba Crash Reporting': 'Alibaba',
  'Alibaba AutoNavi': 'Alibaba',
  'Alibaba Analytics': 'Alibaba',
  Yueying: 'Alibaba',
  'Tencent Login': 'Tencent',
  'Sensors Analytics': 'Sensors Data',
  Parse: 'Parse',
  Sentry: 'Sentry',
  Kakao: 'Kakao',
  BidMachine: 'BidMachine',
  HyprMX: 'HyprMX',
  Verve: 'Verve Group',
  'Ogury Presage': 'Ogury',
  PubNative: 'PubNative',
  OneSignal: 'OneSignal',
  HelpShift: 'HelpShift',
  LeanPlum: 'Leanplum',
  SuperAwesome: 'SuperAwesome',
  'IAB Open Measurement': 'IAB Tech Lab'
};

const permissions = {
  NSPhotoLibraryUsageDescription: 'PhotoLibrary',
  NSCameraUsageDescription: 'Camera',
  NSLocationWhenInUseUsageDescription: 'LocationWhenInUse',
  NSLocationAlwaysUsageDescription: 'LocationAlways',
  NSPhotoLibraryAddUsageDescription: 'PhotoLibraryAdd',
  NSMicrophoneUsageDescription: 'Microphone',
  NSCalendarsUsageDescription: 'Calendars',
  NSLocationAlwaysAndWhenInUseUsageDescription: 'LocationAlwaysAndWhenInUse',
  NSContactsUsageDescription: 'Contacts',
  NSBluetoothPeripheralUsageDescription: 'BluetoothPeripheral',
  NSLocationUsageDescription: 'Location',
  NSMotionUsageDescription: 'Motion',
  NSLocalNetworkUsageDescription: 'LocalNetwork',
  NSNearbyInteractionUsageDescription: 'NearbyInteraction',
  NSAppleMusicUsageDescription: 'AppleMusic',
  NSBluetoothAlwaysUsageDescription: 'BluetoothAlways',
  NSFaceIDUsageDescription: 'FaceID',
  NSRemindersUsageDescription: 'Reminders',
  NSSpeechRecognitionUsageDescription: 'SpeechRecognition',
  NSHealthUpdateUsageDescription: 'HealthUpdate',
  NSHealthShareUsageDescription: 'HealthShare',
  NSSiriUsageDescription: 'Siri',
  NFCReaderUsageDescription: 'NFCReader',
  NSHomeKitUsageDescription: 'HomeKit',
  NSUserTrackingUsageDescription: 'Tracking'
};

function commandOk(command, args) {
  const res = spawnSync(command, args, { encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout;
}

function plistToJson(plistBuffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trackerscan-plist-'));
  const plistPath = path.join(tmpDir, 'Info.plist');
  try {
    fs.writeFileSync(plistPath, plistBuffer);
    const json = commandOk('python3', [path.join(__dirname, 'plist_to_json.py'), plistPath]);
    return json ? JSON.parse(json) : null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readPlistFromIpa(ipa, infoPath) {
  const unzip = spawnSync('unzip', ['-p', ipa, infoPath], { encoding: 'buffer' });
  if (unzip.status !== 0 || !unzip.stdout.length) return null;

  const info = plistToJson(unzip.stdout);
  return info && typeof info === 'object' ? info : null;
}

function extractInfoPlistsFromIpa(ipa) {
  const result = {
    mainPath: null,
    main: null,
    appExtensions: []
  };

  if (!ipa || !fs.existsSync(ipa)) return result;

  const listing = commandOk('zipinfo', ['-1', ipa]) || commandOk('unzip', ['-Z1', ipa]);
  if (!listing) return result;

  const entries = listing.split('\n');
  result.mainPath = entries.find((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry)) || null;
  if (result.mainPath) {
    result.main = readPlistFromIpa(ipa, result.mainPath);
  }

  const appexInfoPaths = entries.filter((entry) =>
    /^Payload\/[^/]+\.app\/(PlugIns|Extensions)\/[^/]+\.appex\/Info\.plist$/.test(entry)
  );
  for (const infoPath of appexInfoPaths) {
    const info = readPlistFromIpa(ipa, infoPath);
    if (info) result.appExtensions.push({ path: infoPath, info });
  }

  return result;
}

function extractPermissionsFromInfoPlist(info) {
  if (!info || typeof info !== 'object') return [];

  return Object.keys(info)
    .filter((key) => key.startsWith('NS') && key.endsWith('UsageDescription'))
    .map((key) => permissions[key] || key.replace(/^NS/, '').replace(/UsageDescription$/, ''))
    .sort();
}

const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const uploadInstrumentationClasses = process.env.UPLOAD_INSTRUMENTATION_CLASSES === '1';
const maxInstrumentationExamples = parseInt(process.env.INSTRUMENTATION_CLASS_EXAMPLES || '50', 10);
const infoPlists = extractInfoPlistsFromIpa(ipaPath);
const trackers = {};
const non_trackers = {};
const tracker_details = [];

function compactRawTrackerscan(value) {
  if (uploadInstrumentationClasses) return value;
  if (!value || !Array.isArray(value.matches)) return value;
  return {
    ...value,
    matches: value.matches.map((match) => {
      if (!match || !isInstrumentationSignature(match.name)) return match;
      const classes = match.classes || [];
      const compact = { ...match };
      delete compact.classes;
      compact.class_count = classes.length;
      compact.class_examples = classes.slice(0, maxInstrumentationExamples);
      return compact;
    })
  };
}

for (const match of raw.matches || []) {
  if (!match || !match.name) continue;
  const name = match.name;
  const canonicalName = canonicalTrackerName(name);
  const detail = {
    id: match.id,
    name,
    canonical_name: canonicalName,
    classes: match.classes || [],
    sources: match.sources || []
  };

  if (isInstrumentationSignature(name)) {
    non_trackers[name] = true;
  } else if (nonTrackers.has(canonicalName)) {
    non_trackers[name] = true;
  } else {
    trackers[name] = companies[canonicalName] || companies[name] || canonicalName;
    tracker_details.push(detail);
  }
}

const result = {
  success: true,
  analysis_source: 'trackerscan-ios',
  analysis_version: analysisVersionArg || process.env.ANALYSIS_VERSION || null,
  signature_set: signatureSetArg || process.env.TRACKERSCAN_SIGNATURE_SET || null,
  signature_path: signaturePathArg || process.env.TRACKERSCAN_SIGNATURES || null,
  bundleID: raw.bundleID || appId,
  version: raw.version || null,
  trackers,
  non_trackers,
  permissions: raw.permissions || extractPermissionsFromInfoPlist(infoPlists.main),
  tracker_details,
  trackingDomains: raw.trackingDomains || [],
  privacyTracking: Boolean(raw.privacyTracking),
  privacyManifests: raw.privacyManifests || 0,
  classCount: raw.classCount || 0,
  scannedImages: raw.scannedImages || 0,
  candidateImages: raw.candidateImages || 0,
  appexCount: raw.appexCount || 0,
  appexScanned: raw.appexScanned || 0,
  raw_info_plist_path: infoPlists.mainPath,
  raw_info_plist: infoPlists.main,
  raw_appex_info_plists: infoPlists.appExtensions,
  raw_trackerscan: compactRawTrackerscan(raw)
};

if (raw.runtimeError) result.runtimeError = raw.runtimeError;
if (raw.encryptedBinaries) result.encryptedBinaries = raw.encryptedBinaries;

fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Results written to ${outPath}`);
