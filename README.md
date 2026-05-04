# TrackerControl for iOS

This repository provides the code for a tracker analysis tool for iOS. It is inspired by the existing [TrackerControl app for Android](https://trackercontrol.org).

## Getting started

Start the server with `npm run watch` (during development) or `npm run start` (for production).

You also need to set up a server to run the script `analyser/processQueue.sh`. This server, in turn, will need to be connected to a jailbroken iPhone that runs Frida. The iPhone should be configured such that the display is always on.

The analyser downloads free App Store apps with `ipatool download --purchase` using the currently authenticated `ipatool` account. Run `ipatool auth login` once on the analyser machine, then configure `UPLOAD_PASSWORD` in `analyser/.env` so the queue processor can authenticate with the web server. `APPLE_EMAIL` and `APPLE_PASS` are optional and are only used when the script needs to retry an `ipatool auth login`.

The default analysis path is `ANALYSIS_MODE=trackerscan`. It installs the IPA, runs the on-device `trackerscan` CLI over SSH, converts the raw scanner JSON into the website's existing analysis format, and uploads it as analysis version 3. The full original scanner output is stored in `analysis.raw_trackerscan` so later analyses can reprocess fields that the website does not display yet. Configure the SSH command with `TRACKERSCAN_CMD`; the default is `ssh iphone trackerscan`, which matches an analyser host that reaches the jailbroken device through an `iphone` SSH alias or `iproxy` setup. The legacy Frida flow is still available with `ANALYSIS_MODE=frida`.

Raw scanner output can be larger than Express' default request body limit. The server defaults `BODY_LIMIT` to `25mb`; set a higher value on Railway if uploads still fail with HTTP 413.

To prevent runaway App Store downloads, `analyser/processQueue.sh` has conservative defaults: 2 download attempts per app, a 50 GB daily download cap, a 3 GB per-attempt watchdog, a 3 GB maximum IPA size, and a 1 hour pause after 5 consecutive failures. Override these in `analyser/.env` with `MAX_DOWNLOAD_ATTEMPTS`, `MAX_DAILY_DOWNLOAD_BYTES`, `MAX_ATTEMPT_DOWNLOAD_BYTES`, `MAX_APP_SIZE_BYTES`, `CONSECUTIVE_FAILURE_LIMIT`, and `CIRCUIT_BREAKER_SLEEP`. The watchdog reads interface byte counters on Linux and macOS; set `NETWORK_INTERFACE` if auto-detection picks the wrong interface. Before installing, the analyser preflights IPA metadata and uses the `appinst` fallback for packages that contain non-whitelisted extension points. `COMPATIBLE_EXTENSION_POINTS` defaults to common extension points supported up to the iOS 16 analyser device.

The `/queue` endpoint hands the analyser the next app by stored App Store review count, highest first. It includes apps that were never analysed, apps with stale results, and expired processing markers. An analysis is stale when `analysisversion` is not the current version, or when it is older than `STALE_ANALYSIS_DAYS` days. A processing marker expires after `PROCESSING_TIMEOUT_MINUTES`. The defaults are `CURRENT_ANALYSIS_VERSION=3`, `STALE_ANALYSIS_DAYS=180`, and `PROCESSING_TIMEOUT_MINUTES=120`. When `/queue` selects a stale app, it snapshots the current result into `app_analyses` before marking the app as in progress. Run `npm run priority-report -- --limit=20` to inspect the next apps and failed apps without modifying the database.

Back up the current database with `npm run backup-db`; this writes a timestamped JSON export under `backups/` and includes `apps` plus `app_analyses` if the history table exists. Apply pending SQL migrations with `npm run migrate`. Migration `001_app_analyses.sql` adds append-only analysis history while keeping `apps.analysis` as the latest/current result used by the website.

After applying the history migration, the analyser can proceed through `/queue` directly. `npm run queue-refetch` remains available as a manual override for forcing specific apps back into the queue, but it is no longer needed for normal stale refetching.

To reset an individual app for another analyser run, use `reset-app`. Omit `--apply` for a dry run:

```sh
npm run reset-app -- --appid=com.google.ios.youtube --apply
```

You can pass `--appid=` multiple times. If the app already has a current analysis row, the script snapshots it into `app_analyses` before clearing `apps.analysis`, `apps.analysisversion`, and `apps.analysed`.

To process one specific app immediately through the normal analyser flow, set `ONLY_APP_ID`. This snapshots and clears the current analysis for that app, then downloads, installs, analyses, uploads, and exits without asking `/queue` for the next priority app:

```sh
ONLY_APP_ID=com.spotify.client bash analyser/processQueue.sh
```

## Credits
- Oxford SOCIAM Project: <https://sociam.org/mobile-app-x-ray>
- PlatformControl: <https://www.platformcontrol.org>
- Exodus Privacy: <https://exodus-privacy.eu.org/>
- frida-ios-hook: <https://github.com/noobpk/frida-ios-hook>
