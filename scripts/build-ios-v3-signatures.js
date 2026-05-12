#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const inputPath = path.join(repoRoot, 'analyser', 'data', 'ios_signatures_v2.json');
const outputPath = path.join(repoRoot, 'analyser', 'data', 'ios_signatures_v3.json');
const metadataPath = path.join(repoRoot, 'analyser', 'data', 'ios_signatures_v3.metadata.json');
const summaryPath = path.join(repoRoot, 'analyser', 'data', 'ios_signatures_v3.summary.json');

const refinements = new Map([
  ['Adobe Experience Cloud', {
    sourceName: null,
    mergeDuplicateNames: ['Adobe Experience Cloud'],
    regex: '^ADBMobile$|^AEPMobileCore|^AEPIdentity|^AEPEdgeIdentity|^AEPMobileSignal',
    notes: 'Merged duplicate legacy Adobe Experience Cloud v1 entries into one canonical visible signature.',
    evidence: {
      merged_legacy_ids: [28, 29],
      top_classes: ['ADBMobile', 'AEPMobileCore', 'AEPIdentity', 'AEPEdgeIdentity', 'AEPMobileSignal']
    }
  }],
  ['Amazon Advertisement', {
    sourceName: 'Amazon Advertisement - v2 refined',
    regex: '^AmazonAdView|^AmazonAdOptions|^ALAmazonAd|^DTBAd|^OMIDAmazon',
    notes: 'Merged v2 Amazon Publisher Services/DTB refinement into canonical v1 signature; avoids exposing a duplicate tracker name.',
    evidence: {
      v2_apps: 189,
      v2_class_matches: 2670,
      top_classes: ['ALAmazonAdLoader', 'ALAmazonAdLoaderDelegate', 'ALAmazonAdSlot', 'ALDTBAds', 'DTBAdBannerDispatcherDelegate', 'DTBAdInterstitialDispatcherDelegate']
    }
  }],
  ['AppMetrica', {
    sourceName: 'AppMetrica - v2 refined',
    regex: '^YMM|^AMAAppMetrica|^YandexMobileMetrica',
    notes: 'Merged AMAAppMetrica anchors into canonical v1 signature.',
    evidence: {
      v2_apps: 30,
      v2_class_matches: 3024,
      domain_validated_apps: 14,
      raw_only_domain_validated_apps: 1,
      top_classes: ['AMAAppMetrica', 'AMAAppMetricaConfiguration', 'AMAAppMetricaReporting', 'AMAAppMetricaImpl']
    }
  }],
  ['Mintegral', {
    sourceName: 'Mintegral - v2 refined',
    regex: '^MTGSDK$|^MTGBanner|^MTGBid|^MTGInterstitial|^MTGRewarded|^MTGNative|^ALMintegral|^GADMAdapterMintegral',
    notes: 'Merged v2 Mintegral direct/ad-unit anchors into canonical v1 signature; avoids broad MTG-only matching.',
    evidence: {
      v2_apps: 138,
      v2_class_matches: 11374,
      top_classes: ['MTGBannerAdViewDelegate', 'MTGBidInterstitialVideoDelegate', 'MTGBannerAdManager', 'MTGBannerAdRequest', 'MTGBannerAdView']
    }
  }],
  ['myTarget', {
    sourceName: 'myTarget - v2 refined',
    regex: '^MTRGAd|^MTRGInterstitial|^MTRGRewarded|^ALMyTarget|^SMLMyTarget',
    notes: 'Merged v2 myTarget ad/delegate/adapter anchors into canonical v1 signature.',
    evidence: {
      v2_apps: 81,
      v2_class_matches: 1217,
      top_classes: ['MTRGAdViewDelegate', 'MTRGInterstitialAdDelegate', 'MTRGRewardedAdDelegate', 'SMLMyTargetBridge']
    }
  }],
  ['Braze (formerly Appboy)', {
    regex: 'Appboy|^Braze|^BRZ|BrazeKit|BrazeUI|PodsDummy_Braze',
    notes: 'Expanded legacy Appboy anchor with modern Braze/BrazeKit/BrazeUI class evidence mined from domain-disclosing class dumps.',
    evidence: {
      domain_validated_apps: 12,
      newly_covered_domain_apps: 7,
      top_domains: ['braze.com', 'braze.eu'],
      top_classes: ['BrazeContentCardUIViewControllerDelegate', 'BrazeInAppMessageUIDelegate', 'BrazeBannerManager', 'BRZContentCardUIViewController']
    }
  }]
]);

const promotions = new Map([
  ['PubNative', {
    regex: '^SMLPubNative|^OMIDPubnativenet|^PubNative',
    tier: 'v3-domain-validated',
    notes: 'Promoted because declared tracking domain server.pubnative.net corroborates hidden v2 PubNative class evidence; anchor is prefix-only to avoid MoPubNative false positives.',
    evidence: {
      v2_apps: 105,
      v2_class_matches: 2944,
      domain_validated_apps: 54,
      raw_only_domain_validated_apps: 52,
      top_domains: ['server.pubnative.net'],
      top_classes: ['OMIDPubnativenetActivityMonitor', 'OMIDPubnativenetAdEvents', 'OMIDPubnativenetAdSession', 'SMLPubNativeBridge']
    }
  }],
  ['Singular', {
    regex: '^Singular$|^Singular(Config|SDK|FeatureFlagsManager|FraudConfiguration|GlobalProperty|HttpRequest|Link|Links|Session|SKAN|User|Wrapper)|^SingularKidsSDK',
    tier: 'v3-domain-validated',
    notes: 'Promoted with a tightened regex because safetrack.singular.net corroborates hidden v2 Singular SDK-core classes; generic Singular* UI terms remain excluded.',
    evidence: {
      v2_apps: 34,
      v2_class_matches: 421,
      domain_validated_apps: 22,
      raw_only_domain_validated_apps: 19,
      top_domains: ['safetrack.singular.net', 'safetrack-s2s.singular.net'],
      top_classes: ['Singular', 'SingularConfig', 'SingularFeatureFlagsManager', 'SingularFraudConfiguration', 'SingularGlobalProperty', 'SingularHttpRequest']
    }
  }],
  ['OneSignal', {
    regex: '^OneSignal|^OneSignaliOSSDK',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because the corpus shows repeated SDK-core OneSignal classes with low false-positive risk.',
    evidence: {
      v2_apps: 31,
      v2_class_matches: 1181,
      top_classes: ['OneSignal', 'OneSignalAppDelegate', 'OneSignalClient', 'OneSignalCoreHelper', 'OneSignalExtension']
    }
  }],
  ['BidMachine', {
    regex: '^BidMachine|^SMLBidMachine|^ALBidMachine',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes are vendor-specific SDK/ad delegate anchors across the corpus.',
    evidence: {
      v2_apps: 120,
      v2_class_matches: 973,
      top_classes: ['BidMachineAdDelegate', 'SMLBidMachineBridge', 'SMLBidMachineEmptyDelegate', 'ALBidMachineMediationAdapter']
    }
  }],
  ['Ogury Presage', {
    regex: '^Ogury|^SMLOgury|^ALOguryPresage|^OMIDOgury',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Ogury/Presage namespaces and ad delegates.',
    evidence: {
      v2_apps: 87,
      v2_class_matches: 2901,
      top_classes: ['OguryAdsInterstitialDelegate', 'OguryAdsOptinVideoDelegate', 'OguryInterstitialAdDelegate', 'SMLOguryBridge']
    }
  }],
  ['HyprMX', {
    regex: '^HyprMX|^SMLHyprMX|^HyprMXAdMob',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct HyprMX placement/delegate namespaces across the corpus.',
    evidence: {
      v2_apps: 73,
      v2_class_matches: 405,
      top_classes: ['HyprMXPlacementDelegate', 'HyprMXPlacementShowDelegate', 'SMLHyprMXBridge', 'SMLHyprMXEmptyDelegate']
    }
  }],
  ['HelpShift', {
    regex: '^Helpshift',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Helpshift SDK namespaces across the corpus.',
    evidence: {
      v3_candidate_apps: 33,
      top_classes: ['Helpshift', 'HelpshiftChatViewController', 'HelpshiftDelegate', 'HelpshiftFAQsViewController']
    }
  }],
  ['mParticle', {
    regex: '^MPKit|^MParticle|^mParticle',
    tier: 'v3-domain-validated',
    notes: 'Promoted with tightened anchors because corpus classes use direct MPKit/mParticle namespaces and mparticle.weather.com appears in declared tracking domains.',
    evidence: {
      v3_candidate_apps: 17,
      domain_validated_apps: 1,
      top_domains: ['mparticle.weather.com'],
      top_classes: ['MPKitAPI', 'MPKitActivity', 'MPKitConfiguration', 'MPKitContainerProtocol']
    }
  }],
  ['LeanPlum', {
    regex: '^Leanplum|^LeanPlum',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Leanplum SDK namespaces across the corpus.',
    evidence: {
      v3_candidate_apps: 15,
      top_classes: ['Leanplum', 'LeanplumCompatibility', 'LeanplumExtension', 'LeanplumSocket']
    }
  }],
  ['Instabug', {
    regex: '^Instabug|^IBGInstabug',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Instabug SDK namespaces; generic IBGRepro classes remain excluded.',
    evidence: {
      v3_candidate_apps: 14,
      top_classes: ['Instabug', 'InstabugBugReporting', 'InstabugNetworkLogger', 'IBGInstabugLog']
    }
  }],
  ['Dynatrace', {
    regex: '^Dynatrace|^PodsDummy_Pods_Dynatrace',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Dynatrace SDK namespaces.',
    evidence: {
      v3_candidate_apps: 10,
      top_classes: ['Dynatrace', 'DynatraceCustomization', 'DynatraceSwiftUI', 'DynatraceRNBridge']
    }
  }],
  ['Nielsen', {
    regex: '^NielsenAppSDK',
    tier: 'v3-domain-validated',
    notes: 'Promoted because observed classes use NielsenAppSDK namespaces and imrworldwide.com is declared in tracking domains.',
    evidence: {
      v3_candidate_apps: 9,
      domain_validated_apps: 2,
      top_domains: ['imrworldwide.com'],
      top_classes: ['NielsenAppSDKJSHandler']
    }
  }],
  ['Chartbeat', {
    regex: '^Chartbeat',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Chartbeat SDK configuration namespaces.',
    evidence: {
      v3_candidate_apps: 8,
      top_classes: ['ChartbeatConfig']
    }
  }],
  ['Segment', {
    regex: '^SEGAnalytics|^SegmentsSDK',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use the known Segment iOS SEGAnalytics anchor across the corpus.',
    evidence: {
      v3_candidate_apps: 8,
      top_classes: ['SEGAnalytics', 'SEGAnalyticsConfiguration', 'SEGAnalyticsExperimental']
    }
  }],
  ['Countly', {
    regex: '^Countly|^CLCountly',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Countly SDK namespaces; generic contains-Countly matches remain excluded.',
    evidence: {
      v3_candidate_apps: 6,
      top_classes: ['Countly', 'CountlyConfig', 'CountlyConnectionManager', 'CLCountly']
    }
  }],
  ['UXCam', {
    regex: '^UXCam|^FlutterUXCam',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct UXCam SDK namespaces.',
    evidence: {
      v3_candidate_apps: 4,
      top_classes: ['UXCam', 'UXCamConfiguration', 'UXCamHandler', 'FlutterUXCam']
    }
  }],
  ['Pendo', {
    regex: '^Pendo|^PNDPendo',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Pendo SDK namespaces.',
    evidence: {
      v3_candidate_apps: 3,
      top_classes: ['Pendo', 'PendoAPI', 'PendoManager', 'PNDPendoAPIConfiguration']
    }
  }],
  ['Criteo', {
    regex: '^Criteo|^PodsDummy_CriteoPublisherSdk|^_TtP18CriteoPublisherSdk',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use Criteo Publisher SDK namespaces.',
    evidence: {
      v3_candidate_apps: 3,
      top_classes: ['PodsDummy_CriteoPublisherSdk', '_TtP18CriteoPublisherSdk13CRMRAIDLogger_']
    }
  }],
  ['Rollbar', {
    regex: '^Rollbar',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Rollbar SDK namespaces.',
    evidence: {
      v3_candidate_apps: 3,
      top_classes: ['Rollbar', 'RollbarBody', 'RollbarCallStackFrame', 'RollbarCaptureIpTypeUtil']
    }
  }],
  ['AdTiming', {
    regex: '^ADTiming|^ACADTiming',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct AdTiming SDK manager namespaces.',
    evidence: {
      v3_candidate_apps: 3,
      top_classes: ['ACADTiming', 'ACADTimingManager']
    }
  }],
  ['KIDOZ', {
    regex: '^Kidoz|^_TtP8KidozSDK',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct KidozSDK ad delegate namespaces.',
    evidence: {
      v3_candidate_apps: 2,
      top_classes: ['_TtP8KidozSDK19KidozBannerDelegate_', '_TtP8KidozSDK21KidozRewardedDelegate_']
    }
  }],
  ['Pushwoosh', {
    regex: '^Pushwoosh|^PWPushwoosh',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Pushwoosh SDK namespaces.',
    evidence: {
      v3_candidate_apps: 2,
      top_classes: ['Pushwoosh', 'PushwooshConfig', 'PushwooshCoreManager', 'PWPushwooshJSBridge']
    }
  }],
  ['Tappx', {
    regex: '^Tappx|^OMIDTappx|TappxSDKProtocol',
    tier: 'v3-corpus-validated-direct',
    notes: 'Promoted because observed classes use direct Tappx SDK and OMID namespaces.',
    evidence: {
      v3_candidate_apps: 2,
      top_classes: ['OMIDTappxSDK', 'UIViewControllerMRAIDTappxSDKProtocol', 'UIViewCoreTappxSDKProtocol']
    }
  }],
  ['Tenjin', {
    regex: '^Tenjin',
    tier: 'v3-domain-validated',
    notes: 'Promoted because observed classes use direct Tenjin SDK namespaces and track.tenjin.com is declared in tracking domains.',
    evidence: {
      v3_candidate_apps: 1,
      domain_validated_apps: 1,
      top_domains: ['track.tenjin.com'],
      top_classes: ['Tenjin', 'TenjinConfig', 'TenjinSDK', 'TenjinUtil']
    }
  }],
  ['PubMatic', {
    regex: '^OMIDPubmatic|^ALPubMatic|^MAPOB|^POB|^CMOpenWrapAds',
    tier: 'v3-domain-validated',
    notes: 'Promoted from domain/class mining because oi-ow.pubmatic.com apps consistently expose PubMatic/OpenWrap/OMIDPubmatic classes.',
    evidence: {
      domain_validated_apps: 39,
      top_domains: ['oi-ow.pubmatic.com'],
      top_classes: ['OMIDPubmaticAdSession', 'OMIDPubmaticAdEvents', 'ALPubMaticMediationAdapter', 'MAPOBNativeAd']
    }
  }],
  ['OutBrain', {
    regex: '^Outbrain|^OutBrain',
    tier: 'v3-domain-validated',
    notes: 'Promoted from domain/class mining because outbrain.com domains have direct Outbrain classes in one app; remaining domain-only apps stay documented as gaps.',
    evidence: {
      domain_validated_apps: 5,
      class_validated_apps: 1,
      top_domains: ['outbrain.com', 'outbrainimg.com'],
      top_classes: ['Outbrain', 'OutbrainHelper', 'OutbrainManager']
    }
  }]
]);

const hiddenDecisions = new Map([
  ['IAB Open Measurement', 'Hidden: measurement infrastructure, not a tracker company by itself.'],
  ['SuperAwesome', 'Hidden: current automated evidence is mostly SML/adapter bridge classes and does not meet the visible threshold.'],
  ['Verve', 'Hidden: current automated evidence is mostly SafeDK/AppLovin/ironSource adapter classes and does not meet the visible threshold.'],
  ['Instabug', 'Hidden pending policy/domain validation: SDK-core evidence exists, but no tracking-domain corroboration yet.'],
  ['Nielsen', 'Hidden pending more samples: imrworldwide.com corroborates two apps, but class evidence is currently sparse.'],
  ['mParticle', 'Hidden pending more samples: one mparticle.weather.com corroborated app and broader class evidence.'],
  ['Braze (formerly Appboy)', 'Legacy visible remains unchanged; missing Braze-domain cases need a separate class anchor update.'],
  ['Kochava', 'Legacy visible remains unchanged; missing Kochava-domain cases need class-level inspection.'],
  ['PubMatic', 'No v3 class promotion yet: domains are present, but no safe iOS class anchor has been validated.'],
  ['Facebook', 'Legacy visible remains unchanged; domain-only Facebook cases may be manifest-only or require a separate automated anchor update.'],
  ['Tune', 'Suppressed: noisy iTunes/tuner false positives.'],
  ['Radar', 'Suppressed: noisy Stripe Radar/chart radar false positives.'],
  ['Reveal Mobile', 'Suppressed: noisy reveal UI false positives.'],
  ['Repro', 'Suppressed: noisy Instabug repro/generic reproduction false positives.'],
  ['X-Mode', 'Suppressed: noisy XModel false positives.'],
  ['Huawei Mobile Services (HMS) Core', 'Suppressed: noisy generic LocationSDK matches.'],
  ['SmartLook', 'Suppressed: observed BU/PAG ad manager bridge classes are not sufficient Smartlook SDK evidence.']
]);

const semanticValidation = new Map([
  ['Adobe Experience Cloud', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Merged two legacy Adobe Experience Cloud anchors into one canonical signature covering ADBMobile and AEP SDK namespaces.',
    validated_classes: ['ADBMobile', 'AEPMobileCore', 'AEPIdentity', 'AEPEdgeIdentity', 'AEPMobileSignal']
  }],
  ['Amazon Advertisement', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are Amazon Publisher Services/DTB, ALAmazonAd, and OMIDAmazon namespaces; these are vendor-specific ad SDK or adapter anchors.',
    validated_classes: ['ALAmazonAdLoader', 'ALAmazonAdSlot', 'DTBAdLoader', 'DTBAds', 'OMIDAmazon1AdSession']
  }],
  ['AppMetrica', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are AMAAppMetrica, YandexMobileMetrica, and YMM-prefixed AppMetrica namespaces; YMM vendored dependency names are retained only because they sit inside the Yandex/AppMetrica namespace.',
    validated_classes: ['AMAAppMetrica', 'AMAAppMetricaConfiguration', 'AMAAppMetricaReporting', 'YMMYandexMetrica', 'YandexMobileMetrica']
  }],
  ['Mintegral', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low-medium',
    notes: 'Matched classes include direct MTG SDK/ad-unit classes plus AdMob/AppLovin adapter classes; the regex avoids generic MTG-only matching.',
    validated_classes: ['MTGSDK', 'MTGBannerAdViewDelegate', 'MTGBidInterstitialVideoDelegate', 'GADMAdapterMintegralUtils', 'ALMintegralMediationAdapter']
  }],
  ['myTarget', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct MTRG ad SDK classes with some SMLMyTarget bridge evidence.',
    validated_classes: ['MTRGAdViewDelegate', 'MTRGInterstitialAdDelegate', 'MTRGRewardedAdDelegate', 'MTRGAdService', 'SMLMyTargetBridge']
  }],
  ['Braze (formerly Appboy)', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are modern Braze/BrazeKit/BrazeUI namespaces and are corroborated by Braze tracking domains.',
    validated_classes: ['BrazeContentCardUIViewControllerDelegate', 'BrazeInAppMessageUIDelegate', 'BrazeBannerManager', 'BRZContentCardUIViewController']
  }],
  ['PubNative', {
    verdict: 'promote',
    confidence: 'medium-high',
    risk: 'medium',
    notes: 'Matched classes are PubNative-specific OMID namespaces and SMLPubNative bridge classes, and server.pubnative.net corroborates most domain-disclosing apps; prefix-only matching avoids MoPubNative false positives.',
    validated_classes: ['OMIDPubnativenetAdSession', 'OMIDPubnativenetAdEvents', 'SMLPubNativeBridge', 'SMLPubNativeEmptyDelegate']
  }],
  ['Singular', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct Singular SDK/core attribution classes and are corroborated by safetrack.singular.net where domains are disclosed.',
    validated_classes: ['Singular', 'SingularConfig', 'SingularSDK', 'SingularHttpRequest', 'SingularUserAgentCollector']
  }],
  ['OneSignal', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct OneSignal SDK, notification, receipt, IAP, and analytics bridge classes.',
    validated_classes: ['OneSignal', 'OneSignalClient', 'OneSignalTracker', 'OneSignalTrackFirebaseAnalytics', 'OneSignalTrackIAP']
  }],
  ['BidMachine', {
    verdict: 'promote',
    confidence: 'medium-high',
    risk: 'medium',
    notes: 'Matched classes are BidMachine-specific direct delegate and mediation adapter classes; no generic words are matched, but adapter-only evidence remains weaker than full SDK-core evidence.',
    validated_classes: ['BidMachineAdDelegate', 'SMLBidMachineBridge', 'ALBidMachineMediationAdapter', 'ALBidMachineRewardedDelegate']
  }],
  ['Ogury Presage', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low-medium',
    notes: 'Matched classes are direct Ogury ad delegates, Ogury OMID namespaces, and Ogury-specific mediation bridges.',
    validated_classes: ['OguryAdsInterstitialDelegate', 'OguryInterstitialAdDelegate', 'SMLOguryBridge', 'OMIDOguryAdSession']
  }],
  ['HyprMX', {
    verdict: 'promote',
    confidence: 'medium-high',
    risk: 'low-medium',
    notes: 'Matched classes are HyprMX-specific placement delegates and SMLHyprMX bridge classes.',
    validated_classes: ['HyprMXPlacementDelegate', 'HyprMXPlacementShowDelegate', 'SMLHyprMXBridge', 'SMLHyprMXEmptyDelegate']
  }],
  ['HelpShift', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct Helpshift SDK namespaces observed across the corpus.',
    validated_classes: ['Helpshift', 'HelpshiftChatViewController', 'HelpshiftDelegate', 'HelpshiftFAQsViewController']
  }],
  ['mParticle', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low-medium',
    notes: 'Matched classes are direct MPKit/mParticle SDK namespaces; the regex excludes broad contains-mParticle matches such as LMParticleView.',
    validated_classes: ['MPKitAPI', 'MPKitActivity', 'MPKitConfiguration', 'MParticleUser']
  }],
  ['LeanPlum', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct Leanplum SDK namespaces across the corpus.',
    validated_classes: ['Leanplum', 'LeanplumCompatibility', 'LeanplumExtension', 'LeanplumSocket']
  }],
  ['Instabug', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low-medium',
    notes: 'Matched classes are direct Instabug SDK namespaces; generic reproduction-step IBGRepro evidence remains hidden.',
    validated_classes: ['Instabug', 'InstabugBugReporting', 'InstabugNetworkLogger', 'IBGInstabugLog']
  }],
  ['Dynatrace', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct Dynatrace SDK namespaces.',
    validated_classes: ['Dynatrace', 'DynatraceCustomization', 'DynatraceSwiftUI', 'DynatraceRNBridge']
  }],
  ['Nielsen', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes use the NielsenAppSDK namespace and have imrworldwide.com domain corroboration.',
    validated_classes: ['NielsenAppSDKJSHandler']
  }],
  ['Chartbeat', {
    verdict: 'promote',
    confidence: 'medium-high',
    risk: 'low-medium',
    notes: 'Matched classes use the direct Chartbeat configuration namespace.',
    validated_classes: ['ChartbeatConfig']
  }],
  ['Segment', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes use the known Segment iOS SEGAnalytics namespace across the corpus.',
    validated_classes: ['SEGAnalytics', 'SEGAnalyticsConfiguration', 'SEGAnalyticsExperimental']
  }],
  ['Countly', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct Countly SDK namespaces; generic contains-Countly matches remain excluded.',
    validated_classes: ['Countly', 'CountlyConfig', 'CountlyConnectionManager', 'CLCountly']
  }],
  ['UXCam', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct UXCam SDK namespaces.',
    validated_classes: ['UXCam', 'UXCamConfiguration', 'UXCamHandler', 'FlutterUXCam']
  }],
  ['Pendo', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct Pendo SDK namespaces.',
    validated_classes: ['Pendo', 'PendoAPI', 'PendoManager', 'PNDPendoAPIConfiguration']
  }],
  ['Criteo', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are Criteo Publisher SDK namespaces.',
    validated_classes: ['PodsDummy_CriteoPublisherSdk', '_TtP18CriteoPublisherSdk13CRMRAIDLogger_']
  }],
  ['Rollbar', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct Rollbar SDK namespaces.',
    validated_classes: ['Rollbar', 'RollbarBody', 'RollbarCallStackFrame', 'RollbarCaptureIpTypeUtil']
  }],
  ['AdTiming', {
    verdict: 'promote',
    confidence: 'medium-high',
    risk: 'low-medium',
    notes: 'Matched classes are AdTiming-specific SDK manager namespaces.',
    validated_classes: ['ACADTiming', 'ACADTimingManager']
  }],
  ['KIDOZ', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are KidozSDK ad delegate namespaces.',
    validated_classes: ['_TtP8KidozSDK19KidozBannerDelegate_', '_TtP8KidozSDK21KidozRewardedDelegate_']
  }],
  ['Pushwoosh', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct Pushwoosh SDK namespaces.',
    validated_classes: ['Pushwoosh', 'PushwooshConfig', 'PushwooshCoreManager', 'PWPushwooshJSBridge']
  }],
  ['Tappx', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are Tappx SDK and OMID namespaces.',
    validated_classes: ['OMIDTappxSDK', 'UIViewControllerMRAIDTappxSDKProtocol', 'UIViewCoreTappxSDKProtocol']
  }],
  ['Tenjin', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low',
    notes: 'Matched classes are direct Tenjin SDK namespaces and have track.tenjin.com domain corroboration.',
    validated_classes: ['Tenjin', 'TenjinConfig', 'TenjinSDK', 'TenjinUtil']
  }],
  ['PubMatic', {
    verdict: 'promote',
    confidence: 'high',
    risk: 'low-medium',
    notes: 'Matched classes are PubMatic/OpenWrap/OMIDPubmatic namespaces and are corroborated by PubMatic tracking domains.',
    validated_classes: ['OMIDPubmaticAdSession', 'OMIDPubmaticAdEvents', 'ALPubMaticMediationAdapter', 'MAPOBNativeAd']
  }],
  ['OutBrain', {
    verdict: 'promote',
    confidence: 'medium-high',
    risk: 'medium',
    notes: 'Matched classes are direct Outbrain namespaces in a domain-disclosing app, but most Outbrain domain apps remain domain-only gaps.',
    validated_classes: ['Outbrain', 'OutbrainHelper', 'OutbrainManager']
  }]
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueRegex(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts.flatMap((p) => String(p || '').split('|'))) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join('|');
}

function commentFor(signature) {
  const pieces = [];
  pieces.push(`exposure=${signature.exposure}`);
  pieces.push(`curation_tier=${signature.curation_tier}`);
  if (signature.curation_decision) pieces.push(signature.curation_decision);
  if (signature.comment) pieces.push(signature.comment);
  return pieces.join(' | ');
}

function applyCuration(signature, curation) {
  signature.signature_version = 3;
  signature.exposure = curation.exposure;
  signature.curation_tier = curation.tier;
  signature.curation_decision = curation.decision;
  signature.curation_notes = curation.notes;
  if (curation.merged_from) signature.merged_from = curation.merged_from;
  if (curation.evidence) signature.curation_evidence = curation.evidence;
  if (curation.semantic_validation) signature.semantic_validation = curation.semantic_validation;
}

function runtimeSignature(signature) {
  const out = {
    id: signature.id,
    name: signature.name,
    regex: signature.regex,
    signature_version: signature.signature_version,
    exposure: signature.exposure
  };
  if (signature.dylib) out.dylib = signature.dylib;
  if (signature.plist) out.plist = signature.plist;
  return out;
}

function metadataRecord(signature) {
  const out = {
    id: signature.id,
    name: signature.name,
    signature_version: signature.signature_version,
    exposure: signature.exposure,
    curation_tier: signature.curation_tier,
    curation_decision: signature.curation_decision,
    curation_notes: signature.curation_notes,
    original_validation: signature.validation || null,
    original_evidence: signature.evidence || null,
    comment: signature.comment || null
  };
  if (signature.merged_from) out.merged_from = signature.merged_from;
  if (signature.curation_evidence) out.curation_evidence = signature.curation_evidence;
  if (signature.semantic_validation) out.semantic_validation = signature.semantic_validation;
  return out;
}

const v2 = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const byName = new Map(v2.map((signature) => [signature.name, signature]));
const refinementSourceNames = new Set([...refinements.values()].map((entry) => entry.sourceName).filter(Boolean));
const duplicateLegacyMerges = new Map();
for (const [targetName, entry] of refinements.entries()) {
  for (const duplicateName of entry.mergeDuplicateNames || []) {
    duplicateLegacyMerges.set(duplicateName, targetName);
  }
}
const seenDuplicateLegacyMergeTargets = new Set();
const next = [];
const decisions = [];

for (const original of v2) {
  if (refinementSourceNames.has(original.name)) {
    decisions.push({
      name: original.name,
      action: 'removed',
      reason: `Merged into ${original.validation?.canonical_name || original.name}`
    });
    continue;
  }

  if (duplicateLegacyMerges.has(original.name)) {
    const targetName = duplicateLegacyMerges.get(original.name);
    if (seenDuplicateLegacyMergeTargets.has(targetName)) {
      decisions.push({
        name: original.name,
        action: 'removed',
        reason: `Merged duplicate legacy entry into ${targetName}`
      });
      continue;
    }
    seenDuplicateLegacyMergeTargets.add(targetName);
  }

  const signature = clone(original);
  const validation = signature.validation || {};
  const isLegacy = validation.source === 'v1' || String(validation.tier || '').startsWith('legacy-v1');
  const isInstrumentation = validation.tier === 'instrumentation-match-all' || signature.name === '__ALL_CLASSES__';
  const isNonTracker = [
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
  ].includes(signature.name);

  if (!signature.validation) signature.validation = {};

  if (refinements.has(signature.name)) {
    const refinement = refinements.get(signature.name);
    signature.regex = refinement.regex;
    signature.validation.tier = signature.validation.tier || 'legacy-v1';
    applyCuration(signature, {
      exposure: isNonTracker ? 'non-tracker' : 'visible',
      tier: 'v3-refined-legacy',
      decision: 'merge-refinement',
      merged_from: refinement.sourceName,
      notes: refinement.notes,
      evidence: refinement.evidence,
      semantic_validation: semanticValidation.get(signature.name)
    });
    decisions.push({ name: signature.name, action: 'visible', reason: refinement.notes });
  } else if (promotions.has(signature.name)) {
    const promotion = promotions.get(signature.name);
    signature.regex = promotion.regex;
    signature.validation.tier = promotion.tier;
    signature.validation.source = 'v3-curated';
    signature.validation.canonical_name = signature.validation.canonical_name || signature.name;
    applyCuration(signature, {
      exposure: 'visible',
      tier: promotion.tier,
      decision: 'promote',
      notes: promotion.notes,
      evidence: promotion.evidence,
      semantic_validation: semanticValidation.get(signature.name)
    });
    decisions.push({ name: signature.name, action: 'visible', reason: promotion.notes });
  } else if (isInstrumentation) {
    applyCuration(signature, {
      exposure: 'instrumentation',
      tier: 'instrumentation-match-all',
      decision: 'retain-hidden',
      notes: 'Retained for all-class evidence collection only.'
    });
  } else if (isNonTracker) {
    applyCuration(signature, {
      exposure: 'non-tracker',
      tier: 'legacy-non-tracker',
      decision: 'retain-non-tracker',
      notes: 'Retained for raw evidence but excluded from tracker output.'
    });
  } else if (isLegacy) {
    applyCuration(signature, {
      exposure: 'visible',
      tier: 'legacy-v1',
      decision: 'retain-legacy',
      notes: 'Existing v1 tracker signature retained as website-visible baseline.'
    });
  } else {
    applyCuration(signature, {
      exposure: 'hidden',
      tier: signature.validation.tier || 'candidate',
      decision: 'retain-hidden',
      notes: hiddenDecisions.get(signature.name) || 'Retained for raw evidence collection; not yet promoted to website-visible output.'
    });
  }

  signature.comment = commentFor(signature);
  next.push(signature);
}

const summary = {
  generated_at: new Date().toISOString(),
  input: path.relative(repoRoot, inputPath),
  output: path.relative(repoRoot, outputPath),
  metadata: path.relative(repoRoot, metadataPath),
  runtime_scope: 'offline signature-data generation only; no analyser/converter behavior changes are required to build this file',
  provenance: {
    v2_source_branches: ['ios-class-evidence-refactor', 'ios-v2-analyser'],
    v2_builder: 'tracker-db-mvp/bin/build-ios-signatures-v2.js',
    v2_inputs: [
      'ETIP/Exodus tracker catalogue',
      'CocoaPods metadata mirror and header inspection',
      'SwiftPM/GitHub package metadata where available',
      'trackerscan __ALL_CLASSES__ dumps from the app corpus'
    ],
    v3_method: [
      'merge duplicate v2 refined signatures into canonical v1 tracker names',
      'promote only low-noise vendor-specific class anchors',
      'use tracking-domain corroboration where available',
      'mine stored __ALL_CLASSES__ dumps for domain-disclosed trackers missed by v1/v2 anchors',
      'keep noisy or mediation-only candidates hidden for offline evidence collection'
    ]
  },
  signature_count: next.length,
  removed_duplicate_refinements: [...refinementSourceNames],
  removed_duplicate_legacy_entries: decisions
    .filter((decision) => decision.action === 'removed' && decision.reason.startsWith('Merged duplicate legacy entry'))
    .map((decision) => decision.name),
  visible_count: next.filter((s) => s.exposure === 'visible').length,
  hidden_count: next.filter((s) => s.exposure === 'hidden').length,
  non_tracker_count: next.filter((s) => s.exposure === 'non-tracker').length,
  instrumentation_count: next.filter((s) => s.exposure === 'instrumentation').length,
  promoted_new_signatures: [...promotions.keys()],
  refined_legacy_signatures: [...refinements.keys()],
  conservative_rules: [
    'Legacy v1 signatures remain visible for continuity.',
    'v2 refined signatures are merged into canonical v1 names; duplicate "- v2 refined" names are removed.',
    'New visible v3 signatures must have vendor-specific class anchors and either tracking-domain corroboration or repeated low-noise SDK-core corpus evidence.',
    'Mediation-only or generic-word evidence remains hidden.',
    'Suppressed/noisy signatures remain in the file only for raw evidence collection and are not website-visible.'
  ],
  decisions
};

const runtimeSignatures = next.map(runtimeSignature);
const metadata = {
  generated_at: summary.generated_at,
  signature_file: path.relative(repoRoot, outputPath),
  signature_count: next.length,
  signatures: next.map(metadataRecord)
};

fs.writeFileSync(outputPath, `${JSON.stringify(runtimeSignatures, null, 2)}\n`);
fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(`Wrote ${path.relative(repoRoot, outputPath)} (${runtimeSignatures.length} signatures)`);
console.log(`Wrote ${path.relative(repoRoot, metadataPath)}`);
console.log(`Wrote ${path.relative(repoRoot, summaryPath)}`);
