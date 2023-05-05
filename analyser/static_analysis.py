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

result =  {"trackers": found_trackers, "non_trackers": found_nontrackers, "permissions": list(found_permissions)}

# save results
with open(out_path, 'w') as f:
    json.dump(result, f)

print("Results written to " + out_path)
