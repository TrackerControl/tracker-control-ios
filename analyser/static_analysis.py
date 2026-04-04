#!/usr/bin/env python3
# coding: utf-8

import json
import itertools
import re
import sys
import fnmatch
from zipfile import ZipFile
import plistlib

if len(sys.argv) == 1:
    print("Please provide appId")
    sys.exit(1)

appId = sys.argv[1]

ipa_path = "ipas/" + appId + ".ipa"
class_path = "classes/" + appId + "-classes.txt"
out_path = 'analysis/' + appId + '.json'

nontrackers = [
    "Twitter Account Kit",
    "Google Firebase",
    "Get device information",
    "AdID access",
    "Google Firebase Messaging",
    "Google Consent API",
    "YouTube",
    "Google Sign-In",
    "Google Maps",
    "Amazon AWS",
    "iAd"
]

included_trackers = [
    "Alipay",
    "Tencent Login",
    "Google AdMob",
    "Facebook",
    "Facebook Ads",
    "Facebook Analytics",
    "Google CrashLytics",
    "Google Analytics",
    "Inmobi",
    "Unity3d Ads",
    "Moat",
    "Twitter MoPub",
    "AppLovin (MAX and SparkLabs)",
    "ChartBoost",
    "AdColony",
    "Amazon Analytics (Amazon insights)",
    "HockeyApp",
    "Tapjoy",
    "Branch",
    "Microsoft Visual Studio App Center",            # iOS
    "Microsoft Visual Studio App Center Crashes",    # Android
    "Microsoft Visual Studio App Center Analytics",  # Android
    "Adobe Experience Cloud",
    "MixPanel",
    "Adjust",
    "Amplitude",
    "Heyzap (bought by Fyber)",
    "Amazon Advertisement",
    "Vungle",
    "AppsFlyer",
    "WeChat",          # iOS
    "Baidu",           # iOS + Android
    #"Baidu APPX",
    #"Baidu Location",
    "Baidu Map",
    "Baidu Mobile Ads",
    "Baidu Mobile Stat",
    #"Baidu Navigation",
    #"Umeng+",           # iOS + Android
    #"Umeng Analytics",
    #"Umeng Feedback",
    "JiGuang Aurora Mobile JPush",
    "Tencent",
    "Tencent Ads",
    "Tencent MTA",
    "Bugly",
    "Tencent Map LBS",
    "WeChat Location",
    "ironSource",
    "Startapp",
    "Google Tag Manager",
    "Pollfish",
    "Nexage",
    "Flurry",
    "Verizon Ads",
    "Revmob",
    "New Relic",
    "Supersonic Ads",
    "Appodeal",
    "Fyber",
    "Smaato",
    "Urbanairship",
    "MobFox",
    "Localytics",
    "Appcelerator Analytics",
    "AdBuddiz",
    "Radius Networks",
    "ComScore",
    "Soomla",
    "BugSense",
    "Yandex Ad",
    "Mail.ru",
    "Quantcast",
    "VKontakte SDK",
    "Batch",
    "Tapdaq",
    "Fyber SponsorPay",
    "Ooyala",
    "Google Firebase Analytics",
    "AdTech Mobile SDK",
    "PlayHaven",
    "WeiboSDK",
    #"Weibo",
    "AppMetrica",
    "Mintegral",
    "Ogury Presage",
    "Appnext",
    "myTarget",
    "CleverTap",
    "Sensors Analytics",
    "Braze (formerly Appboy)",
    "Bugsnag",
    "Kochava",
    "Pangle",
    "SKAdNetwork",
    "Google Play Services",
    "Umeng Analytics",
    "Umeng Social",
    "Mob.com",
    "Alibaba Cloud Utils",
    #"Alibaba Cloud Push",
    #"Alibaba Crash Reporting",
    "Alibaba AutoNavi",
    "Alibaba Analytics",
    "Yueying"
]

companies = {
    "Google AdMob": "AdMob",
    "Facebook": "Facebook",
    "Google CrashLytics": "Crashlytics",
    "Google Analytics": "Google Analytics",
    "Inmobi": "InMobi",
    "Unity3d Ads": "Unity Technologies",
    "Moat": "Moat",
    "Twitter MoPub": "MoPub",
    "AppLovin (MAX and SparkLabs)": "AppLovin",
    "ChartBoost": "Chartboost",
    "AdColony": "AdColony",
    "Amazon Analytics (Amazon insights)": "Amazon Analytics",
    "HockeyApp": "Bit Stadium",
    "Tapjoy": "Tapjoy",
    "Branch": "Branch",
    "Microsoft Visual Studio App Center": "App Center",
    "Adobe Experience Cloud": "Adobe Experience Cloud",
    "MixPanel": "Mixpanel",
    "Adjust": "Adjust",
    "Amplitude": "Amplitude",
    "Heyzap (bought by Fyber)": "Heyzap",
    "Amazon Advertisement": "Amazon Advertising",
    "Vungle": "Vungle",
    "AppsFlyer": "AppsFlyer",
    "WeChat": "Tencent",
    "Baidu": "Baidu",
    "Umeng+": "Umeng+",
    "JiGuang Aurora Mobile JPush": "JPush",
    "Tencent MTA": "Tencent",
    "Bugly": "Tencent",
    "Tencent Map LBS": "Tencent",
    "WeChat Location": "Tencent",
    "ironSource": "ironSource",
    "Startapp": "StartApp",
    "Google Tag Manager": "Google Tag Manager",
    "Pollfish": "Pollfish",
    "Nexage": "NEXAGE",
    "Flurry": "Flurry",
    "Verizon Ads": "Verizon Media",
    "Revmob": "RevMob",
    "New Relic": "New Relic",
    "Supersonic Ads": "Supersonic Studios",
    "Appodeal": "Appodeal",
    "Fyber": "Fyber",
    "Smaato": "Smaato",
    "Urbanairship": "Airship",
    "MobFox": "Mobfox",
    "Localytics": "Localytics",
    "Appcelerator Analytics": "Appcelerator",
    "AdBuddiz": "AdBuddiz",
    "Radius Networks": "Radius Networks",
    "ComScore": "comScore",
    "Soomla": "Soomla",
    "BugSense": "BugSense",
    "Yandex Ad": "Yandex",
    "Mail.ru": "Mail.ru",
    "Quantcast": "Quantcast",
    "VKontakte SDK": "VKontakte",
    "Batch": "Batch",
    "Tapdaq": "Tapdaq",
    "Fyber SponsorPay": "Fyber",
    "Ooyala": "Ooyala - Flex Media Platform",
    "Google Firebase Analytics": "Firebase",
    "AdTech Mobile SDK": "AdTech",
    "PlayHaven": "PlayHaven",
    "iAd": "Apple",
    "WeiboSDK": "Weibo",
    "SKAdNetwork": "Apple",
    "CleverTap": "CleverTap",
    "Braze (formerly Appboy)": "Braze",
    "Bugsnag": "Bugsnag",
    "myTarget": "My.com",
    "Tencent": "Tencent",
    "Kochava": "Kochava",
    "Mintegral": "Mintegral",
    "Pangle": "Pangle",
    "AppMetrica": "Yandex",
    "Google Play Services": "Google",
    "Alipay": "Alibaba",
    "Baidu Map": "Baidu",
    "Baidu Mobile Stat": "Baidu",
    "Baidu Mobile Ads": "Baidu",
    "Umeng Analytics": "Umeng+",
    "Umeng Social": "Umeng+",
    "Mob.com": "MobTech",
    "Alibaba Cloud Utils": "Alibaba",
    "Alibaba Cloud Push": "Alibaba",
    "Alibaba Crash Reporting": "Alibaba",
    "Alibaba AutoNavi": "Alibaba",
    "Alibaba Analytics": "Alibaba",
    "Yueying": "Alibaba",
    'Tencent Login': 'Tencent',
    'Sensors Analytics': 'Sensors Data'
}

# Country of origin for each company (ISO 3166-1 alpha-2)
company_countries = {
    "AdMob": "US",
    "Facebook": "US",
    "Crashlytics": "US",
    "Google Analytics": "US",
    "InMobi": "IN",
    "Unity Technologies": "US",
    "Moat": "US",
    "MoPub": "US",
    "AppLovin": "US",
    "Chartboost": "US",
    "AdColony": "US",
    "Amazon Analytics": "US",
    "Bit Stadium": "DE",
    "Tapjoy": "US",
    "Branch": "US",
    "App Center": "US",
    "Adobe Experience Cloud": "US",
    "Mixpanel": "US",
    "Adjust": "DE",
    "Amplitude": "US",
    "Heyzap": "US",
    "Amazon Advertising": "US",
    "Vungle": "US",
    "AppsFlyer": "IL",
    "Tencent": "CN",
    "Baidu": "CN",
    "Umeng+": "CN",
    "JPush": "CN",
    "ironSource": "IL",
    "StartApp": "IL",
    "Google Tag Manager": "US",
    "Pollfish": "US",
    "NEXAGE": "US",
    "Flurry": "US",
    "Verizon Media": "US",
    "RevMob": "BR",
    "New Relic": "US",
    "Supersonic Studios": "IL",
    "Appodeal": "US",
    "Fyber": "DE",
    "Smaato": "US",
    "Airship": "US",
    "Mobfox": "AT",
    "Localytics": "US",
    "Appcelerator": "US",
    "AdBuddiz": "FR",
    "Radius Networks": "US",
    "comScore": "US",
    "Soomla": "IL",
    "BugSense": "US",
    "Yandex": "RU",
    "Mail.ru": "RU",
    "Quantcast": "US",
    "VKontakte": "RU",
    "Batch": "FR",
    "Tapdaq": "GB",
    "Ooyala - Flex Media Platform": "US",
    "Firebase": "US",
    "AdTech": "US",
    "PlayHaven": "US",
    "Apple": "US",
    "Weibo": "CN",
    "CleverTap": "US",
    "Braze": "US",
    "Bugsnag": "GB",
    "My.com": "RU",
    "Kochava": "US",
    "Mintegral": "CN",
    "Pangle": "CN",
    "Google": "US",
    "Alibaba": "CN",
    "MobTech": "CN",
    "Sensors Data": "CN",
}

country_names = {
    "US": "United States",
    "CN": "China",
    "DE": "Germany",
    "IL": "Israel",
    "RU": "Russia",
    "IN": "India",
    "BR": "Brazil",
    "FR": "France",
    "GB": "United Kingdom",
    "AT": "Austria",
}

permissions = {
    'NSPhotoLibraryUsageDescription': 'PhotoLibrary',
    'NSCameraUsageDescription': 'Camera',
    'NSLocationWhenInUseUsageDescription': 'LocationWhenInUse',
    'NSLocationAlwaysUsageDescription': 'LocationAlways',
    'NSPhotoLibraryAddUsageDescription': 'PhotoLibraryAdd',
    'NSMicrophoneUsageDescription': 'Microphone',
    'NSCalendarsUsageDescription': 'Calendars',
    'NSLocationAlwaysAndWhenInUseUsageDescription': 'LocationAlwaysAndWhenInUse',
    'NSContactsUsageDescription': 'Contacts',
    'NSBluetoothPeripheralUsageDescription': 'BluetoothPeripheral',
    'NSLocationUsageDescription': 'Location', # DEPRECATED 
    'NSMotionUsageDescription': 'Motion',
    'NSAppleMusicUsageDescription': 'AppleMusic',
    'NSBluetoothAlwaysUsageDescription': 'BluetoothAlways',
    'NSFaceIDUsageDescription': 'FaceID',
    'NSRemindersUsageDescription': 'Reminders',
    'NSSpeechRecognitionUsageDescription': 'SpeechRecognition',
    'NSHealthUpdateUsageDescription': 'HealthUpdate',
    'NSHealthShareUsageDescription': 'HealthShare',
    'NSSiriUsageDescription': 'Siri',
    'NFCReaderUsageDescription': 'NFCReader',
    'NSHomeKitUsageDescription': 'HomeKit',
    'NSUserTrackingUsageDescription': 'Tracking'
};

with open('data/ios_signatures.json', encoding='utf-8') as fh:
    signatures = json.load(fh)

regexs = []
for signature in signatures:
    regexs.append(signature['regex'])

# taken from: https://github.com/Exodus-Privacy/exodus-core
compiled_tracker_signature = [re.compile(signature['regex'], flags=re.MULTILINE | re.UNICODE)
                                       for signature in signatures]

# taken from: https://github.com/Exodus-Privacy/exodus-core
def detect_trackers(filename):
    with open(filename, 'r') as f:
        class_list = f.readlines()

    if "[*] Completed: Find Classes" not in "\n".join(class_list):
    	raise Exception('Analysis did not finish properly.')
    
    args = [(compiled_tracker_signature[index], tracker, class_list)
                for (index, tracker) in enumerate(signatures)]

    results = []

    def _detect_tracker(sig, tracker, class_list):
        for clazz in class_list:
            if sig.search(clazz):
                return tracker
        return None

    for res in itertools.starmap(_detect_tracker, args):
        if res:
            results.append(res)

    trackers = [t['id'] for t in results if t is not None]
    return trackers

# obtain tracker library ids from blasses
trackers = detect_trackers(class_path)

# lookup companies and library names from tracker library ids
found_trackers = {}
found_nontrackers = {}
for signature in signatures:
    if signature['id'] in trackers:
        name = signature['name']
        if name in included_trackers:
            found_trackers[name] = companies[name]
        
        if name in nontrackers:
            found_nontrackers[name] = True


def parse_ipa_info(ipa_path):
    ipa_zip = ZipFile(ipa_path)
    files = ipa_zip.namelist()
    info_plist = fnmatch.filter(files, "Payload/*.app/Info.plist")[0]
    info_plist_bin = ipa_zip.read(info_plist)
    
    info = plistlib.loads(info_plist_bin)
    ipa_zip.close()
    
    return info

info = parse_ipa_info(ipa_path)
found_permissions = set()
for key in info:
    if key in permissions.keys():
        found_permissions.add(permissions[key])

# Compute destination countries from found trackers
destination_countries = {}
for tracker_name, company_name in found_trackers.items():
    country_code = company_countries.get(company_name)
    if country_code:
        country_label = country_names.get(country_code, country_code)
        if country_code not in destination_countries:
            destination_countries[country_code] = {
                "name": country_label,
                "trackers": []
            }
        destination_countries[country_code]["trackers"].append(tracker_name)

# Classify trackers by purpose for legal assessment
# Uses Exodus Privacy categories via the tracker name mapping
ad_trackers = []
analytics_trackers = []
crash_trackers = []
for tracker_name in found_trackers:
    # Categorise based on known tracker purposes
    is_ad = any(k in tracker_name.lower() for k in ['ad', 'ads', 'adcolony', 'admob',
        'adtech', 'advertisement', 'applovin', 'chartboost', 'fyber', 'heyzap',
        'inmobi', 'ironsource', 'mobfox', 'mopub', 'mintegral', 'nexage', 'pangle',
        'pollfish', 'revmob', 'smaato', 'startapp', 'supersonic', 'tapdaq', 'tapjoy',
        'unity3d ads', 'verizon ads', 'vungle', 'yandex ad', 'appnext', 'ogury',
        'facebook ads', 'tencent ads', 'baidu mobile ads', 'amazon advertisement',
        'mail.ru', 'mytarget'])
    is_analytics = any(k in tracker_name.lower() for k in ['analytics', 'mixpanel',
        'amplitude', 'adjust', 'appsflyer', 'branch', 'flurry', 'kochava',
        'localytics', 'appmetrica', 'clevertap', 'braze', 'sensors', 'comcore',
        'quantcast', 'moat', 'ooyala', 'umeng', 'tencent mta', 'baidu mobile stat',
        'alibaba analytics', 'yueying'])
    is_crash = any(k in tracker_name.lower() for k in ['crash', 'bugly', 'bugsense',
        'bugsnag', 'hockeyapp', 'app center'])
    if is_ad:
        ad_trackers.append(tracker_name)
    elif is_crash:
        crash_trackers.append(tracker_name)
    elif is_analytics:
        analytics_trackers.append(tracker_name)
    else:
        analytics_trackers.append(tracker_name)

# Detect legally-relevant signals from non-tracker signatures
has_idfa_access = 'AdID access' in found_nontrackers
has_consent_sdk = 'Google Consent API' in found_nontrackers
requests_tracking_permission = 'Tracking' in found_permissions  # NSUserTrackingUsageDescription

# Extract App Transport Security exceptions from Info.plist
# ATS exceptions allow insecure HTTP connections - a privacy risk
ats_exceptions = []
ats_dict = info.get('NSAppTransportSecurity', {})
if ats_dict.get('NSAllowsArbitraryLoads', False):
    ats_exceptions.append('AllowsArbitraryLoads')
exception_domains = ats_dict.get('NSExceptionDomains', {})
for domain, settings in exception_domains.items():
    if settings.get('NSExceptionAllowsInsecureHTTPLoads', False) or \
       settings.get('NSTemporaryExceptionAllowsInsecureHTTPLoads', False):
        ats_exceptions.append(domain)

# Extract embedded third-party frameworks from IPA
ipa_zip = ZipFile(ipa_path)
framework_files = fnmatch.filter(ipa_zip.namelist(), "Payload/*.app/Frameworks/*.framework/*")
embedded_frameworks = list(set(
    f.split('/Frameworks/')[1].split('/')[0].replace('.framework', '')
    for f in framework_files
    if '/Frameworks/' in f
))
ipa_zip.close()

# Build privacy concerns list
privacy_concerns = []

# Concern: Ad trackers present (potential GDPR Art 5(3) / ePrivacy violation)
if ad_trackers:
    privacy_concerns.append({
        "id": "ad_trackers",
        "severity": "high",
        "title": "Contains advertising trackers",
        "description": f"This app embeds {len(ad_trackers)} advertising/profiling "
                       f"tracker(s) that likely collect personal data for targeted "
                       f"advertising. Under EU law (GDPR/ePrivacy), this requires "
                       f"explicit user consent before any data is collected.",
        "trackers": ad_trackers,
    })

# Concern: IDFA access without ATT
if has_idfa_access and not requests_tracking_permission:
    privacy_concerns.append({
        "id": "idfa_no_att",
        "severity": "high",
        "title": "Accesses advertising identifier without ATT prompt",
        "description": "The app accesses the device's advertising identifier (IDFA) "
                       "but does not declare NSUserTrackingUsageDescription, meaning "
                       "it may access the IDFA without showing Apple's App Tracking "
                       "Transparency prompt. Since iOS 14.5, apps must obtain explicit "
                       "permission before tracking users across apps.",
    })

# Concern: No consent SDK but has trackers
if (ad_trackers or analytics_trackers) and not has_consent_sdk:
    privacy_concerns.append({
        "id": "no_consent_sdk",
        "severity": "medium",
        "title": "No consent management detected",
        "description": f"The app contains {len(ad_trackers) + len(analytics_trackers)} "
                       f"tracking/analytics SDK(s) but no recognised consent management "
                       f"platform (CMP) was detected. Under GDPR, trackers that are not "
                       f"strictly necessary require informed consent before activation.",
    })

# Concern: Data sent to countries without EU adequacy
non_adequate_countries = {"CN": "China", "RU": "Russia", "IN": "India", "BR": "Brazil"}
flagged_transfers = {}
for code, data in destination_countries.items():
    if code in non_adequate_countries:
        flagged_transfers[code] = data
if flagged_transfers:
    countries_list = ', '.join(
        flagged_transfers[c]["name"] for c in flagged_transfers
    )
    privacy_concerns.append({
        "id": "non_adequate_transfer",
        "severity": "high",
        "title": f"Tracker data may be sent to {countries_list}",
        "description": f"The app contains trackers from companies based in countries "
                       f"without an EU data adequacy decision. Transfers of personal "
                       f"data to these countries require additional safeguards under "
                       f"GDPR Chapter V (e.g. Standard Contractual Clauses).",
        "countries": flagged_transfers,
    })

# Concern: Excessive permissions relative to app category
sensitive_permissions = {'LocationAlways', 'LocationAlwaysAndWhenInUse', 'Contacts',
                         'Calendars', 'Microphone', 'HealthUpdate', 'HealthShare'}
found_sensitive = sensitive_permissions & found_permissions
if len(found_sensitive) >= 3:
    privacy_concerns.append({
        "id": "excessive_permissions",
        "severity": "medium",
        "title": f"Requests {len(found_sensitive)} sensitive permissions",
        "description": f"The app requests access to {', '.join(sorted(found_sensitive))}. "
                       f"Under GDPR's data minimisation principle (Art. 5(1)(c)), apps "
                       f"should only request permissions necessary for their core "
                       f"functionality.",
        "permissions": sorted(found_sensitive),
    })

# Concern: ATS exceptions weaken transport security
if ats_exceptions:
    privacy_concerns.append({
        "id": "ats_exceptions",
        "severity": "medium",
        "title": "Weakened transport security",
        "description": f"The app disables or weakens App Transport Security for "
                       f"{len(ats_exceptions)} domain(s), potentially allowing "
                       f"unencrypted HTTP connections. This increases the risk of "
                       f"data interception. GDPR Art. 32 requires appropriate "
                       f"technical measures to protect personal data.",
        "domains": ats_exceptions[:10],  # cap at 10 for display
    })

result = {
    "trackers": found_trackers,
    "non_trackers": found_nontrackers,
    "permissions": list(found_permissions),
    "destination_countries": destination_countries,
    "tracker_categories": {
        "advertising": ad_trackers,
        "analytics": analytics_trackers,
        "crash_reporting": crash_trackers,
    },
    "privacy_signals": {
        "has_idfa_access": has_idfa_access,
        "has_consent_sdk": has_consent_sdk,
        "requests_tracking_permission": requests_tracking_permission,
        "ats_exceptions": ats_exceptions,
        "embedded_frameworks_count": len(embedded_frameworks),
    },
    "privacy_concerns": privacy_concerns,
}

# save results
with open(out_path, 'w') as f:
    json.dump(result, f)

print("Results written to " + out_path)
