# TrackerControl for iOS

This repository provides the code for a privacy analysis tool for iOS apps. It analyses apps from the Apple App Store to detect embedded trackers, assess privacy risks, and compute a compliance score based on EU data protection law (GDPR/ePrivacy). It is inspired by the existing [TrackerControl app for Android](https://trackercontrol.org).

## What it does

For each app, the analysis produces:

### Tracker detection
- Detects **140+ tracker SDKs** (advertising, analytics, crash reporting) via Frida-based Objective-C class enumeration on a jailbroken iPhone
- Matches class names against regex signatures derived from [Exodus Privacy](https://exodus-privacy.eu.org/)
- No app code is copied or decrypted — analysis runs entirely on-device

### Privacy compliance score
Each app receives a letter grade (A–F) based on 7 criteria weighted by legal severity:

| Criterion | Points | Legal basis | Data source |
|---|---|---|---|
| No pre-consent tracking | 30 | ePrivacy Art. 5(3) | `pre_consent_tracking/<appId>.json` |
| Privacy policy transparency | 20 | GDPR Art. 13/14 | `policy_analysis/<appId>.json` |
| Consent mechanism present | 15 | GDPR Art. 7 | Frida class dump |
| ATT compliance | 10 | Apple ATT policy | Frida + Info.plist |
| No non-adequate transfers | 10 | GDPR Chapter V | Tracker company origins |
| Data minimisation | 10 | GDPR Art. 5(1)(c) | Info.plist permissions |
| Transport security | 5 | GDPR Art. 32 | Info.plist ATS exceptions |

Criteria without data (e.g., no policy analysis available yet) show "n/a" and do not penalise the score.

### Privacy concern detection
Automatically flags:
- **Advertising trackers** present without a consent management platform
- **IDFA access** without an App Tracking Transparency prompt
- **Undisclosed trackers** not mentioned in the app's privacy policy
- **Data transfers** to countries without EU adequacy decisions (China, Russia, India, Brazil)
- **Excessive permissions** (3+ sensitive permissions like always-on location, contacts, health data)
- **Weakened transport security** via App Transport Security exceptions

### Destination countries
Maps each detected tracker to the country of origin of its parent company, highlighting potential cross-border data transfers.

### Privacy policy analysis (external input)
Integrates with an external privacy policy analysis pipeline. Expects a JSON file per app (`policy_analysis/<appId>.json`) with:
- `strict_matches`: tracker companies explicitly named in the policy
- `conservative_matches`: trackers covered only by vague categories (e.g., "third-party partners")
- `undisclosed`: trackers not mentioned in the policy at all

### Pre-consent tracking (external input)
Integrates with traffic capture data from [PlatformControl](https://www.platformcontrol.org). Expects `pre_consent_tracking/<appId>.json` with tracker domains contacted during a passive 30-second run with no user interaction.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Web frontend   │────▶│  Node.js server  │────▶│   PostgreSQL     │
│   (Pug/Bootstrap)│◀────│  (Express.js)    │◀────│                  │
└─────────────────┘     └──────┬───────────┘     └──────────────────┘
                               │ queue
                    ┌──────────▼───────────┐
                    │  processQueue.sh     │
                    │  ├─ ipatool download │
                    │  ├─ Frida class dump │
                    │  └─ static_analysis  │
                    │     ├─ tracker match │
                    │     ├─ plist parse   │
                    │     ├─ policy merge  │
                    │     └─ score compute │
                    └──────────────────────┘
                               │
                    ┌──────────▼───────────┐
                    │  Jailbroken iPhone   │
                    │  (Frida server)      │
                    └──────────────────────┘
```

## Getting started

### Prerequisites
- Node.js
- PostgreSQL
- A jailbroken iPhone connected via USB with Frida server running
- `ipatool` and `ideviceinstaller`
- An Apple ID for downloading apps

### Running the server
```bash
npm install
npm run watch    # development
npm run start    # production
```

Environment variables (`.env`):
- `UPLOAD_PASSWORD` — shared secret between server and analyser

### Running the analyser
```bash
cd analyser
./processQueue.sh
```

The analyser polls the server for queued apps, downloads them via `ipatool`, installs on the connected iPhone, runs Frida for 30 seconds to enumerate classes, then performs static analysis on the IPA.

### Bandwidth safeguards
The analyser includes protections against excessive downloads:
- **50 GB daily download limit** (configurable via `MAX_DAILY_DOWNLOAD_BYTES`)
- **2 GB per-app size limit** (configurable via `MAX_APP_SIZE_MB`)
- **Circuit breaker**: pauses for 10 minutes after 5 consecutive failures

### Optional: external data sources
To enable the full compliance score, provide additional data:

1. **Privacy policy analysis** — place `policy_analysis/<appId>.json` files in the analyser directory
2. **Pre-consent tracking** — place `pre_consent_tracking/<appId>.json` files with domains contacted during passive traffic capture (e.g., from [PlatformControl](https://github.com/TrackerControl/platformcontrol-android-ios-analysis))

## Credits
- Oxford SOCIAM Project: <https://sociam.org/mobile-app-x-ray>
- PlatformControl: <https://www.platformcontrol.org>
- Exodus Privacy: <https://exodus-privacy.eu.org/>
- frida-ios-hook: <https://github.com/noobpk/frida-ios-hook>
- AppCensus / "50 Ways to Leak Your Data" (USENIX Security '19): methodology inspiration
- Fraunhofer SIT / Appicaptor: fingerprinting detection research

## License
AGPLv3
