#!/usr/bin/env node

const fs = require('fs');

const [, , appId, rawPath, outPath] = process.argv;

if (!appId || !rawPath || !outPath) {
  console.error('Usage: trackerscan_to_analysis.js <appId> <raw-json> <analysis-json>');
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
  Kakao: 'Kakao'
};

const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const trackers = {};
const non_trackers = {};
const tracker_details = [];

for (const match of raw.matches || []) {
  if (!match || !match.name) continue;
  const name = match.name;
  const detail = {
    id: match.id,
    name,
    classes: match.classes || [],
    sources: match.sources || []
  };

  if (nonTrackers.has(name)) {
    non_trackers[name] = true;
  } else {
    trackers[name] = companies[name] || name;
    tracker_details.push(detail);
  }
}

const result = {
  success: true,
  analysis_source: 'trackerscan-ios',
  bundleID: raw.bundleID || appId,
  version: raw.version || null,
  trackers,
  non_trackers,
  permissions: [],
  tracker_details,
  trackingDomains: raw.trackingDomains || [],
  privacyTracking: Boolean(raw.privacyTracking),
  privacyManifests: raw.privacyManifests || 0,
  classCount: raw.classCount || 0,
  scannedImages: raw.scannedImages || 0,
  candidateImages: raw.candidateImages || 0,
  appexCount: raw.appexCount || 0,
  appexScanned: raw.appexScanned || 0,
  raw_trackerscan: raw
};

if (raw.runtimeError) result.runtimeError = raw.runtimeError;
if (raw.encryptedBinaries) result.encryptedBinaries = raw.encryptedBinaries;

fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Results written to ${outPath}`);
