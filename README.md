# TrackerControl for iOS

This repository provides the code for a tracker analysis tool for iOS. It is inspired by the existing [TrackerControl app for Android](https://trackercontrol.org).

## Getting started

Start the server with `npm run watch` (during development) or `npm run start` (for production).

You also need to set up a server to run the script `analyser/processQueue.sh`. This server, in turn, will need to be connected to a jailbroken iPhone that runs Frida. The iPhone should be configured such that the display is always on.

The analyser downloads free App Store apps with `ipatool download --purchase` using the currently authenticated `ipatool` account. Run `ipatool auth login` once on the analyser machine, then configure `UPLOAD_PASSWORD` in `analyser/.env` so the queue processor can authenticate with the web server. `APPLE_EMAIL` and `APPLE_PASS` are optional and are only used when the script needs to retry an `ipatool auth login`.

The default analysis path is `ANALYSIS_MODE=trackerscan`. It installs the IPA, runs the on-device `trackerscan` CLI over SSH, converts the raw scanner JSON into the website's existing analysis format, and uploads it as analysis version 3. The full original scanner output is stored in `analysis.raw_trackerscan` so later analyses can reprocess fields that the website does not display yet. Configure the SSH command with `TRACKERSCAN_CMD`; the default is `ssh iphone trackerscan`, which matches an analyser host that reaches the jailbroken device through an `iphone` SSH alias or `iproxy` setup. The legacy Frida flow is still available with `ANALYSIS_MODE=frida`.

To prevent runaway App Store downloads, `analyser/processQueue.sh` has conservative defaults: 2 download attempts per app, a 50 GB daily download cap, a 3 GB per-attempt watchdog, a 3 GB maximum IPA size, and a 1 hour pause after 5 consecutive failures. Override these in `analyser/.env` with `MAX_DOWNLOAD_ATTEMPTS`, `MAX_DAILY_DOWNLOAD_BYTES`, `MAX_ATTEMPT_DOWNLOAD_BYTES`, `MAX_APP_SIZE_BYTES`, `CONSECUTIVE_FAILURE_LIMIT`, and `CIRCUIT_BREAKER_SLEEP`. The watchdog reads interface byte counters on Linux and macOS; set `NETWORK_INTERFACE` if auto-detection picks the wrong interface.

Queued apps are processed by stored App Store review count, highest first. Run `npm run priority-report -- --limit=20` to inspect the most popular queued apps, stale analysed apps worth refetching, and failed apps worth retrying. The report reads `DATABASE_URL` from `.env` or `analyser/.env` and does not modify the database.

Back up the current database with `npm run backup-db`; this writes a timestamped JSON export under `backups/` and includes `apps` plus `app_analyses` if the history table exists. Apply pending SQL migrations with `npm run migrate`. Migration `001_app_analyses.sql` adds append-only analysis history while keeping `apps.analysis` as the latest/current result used by the website.

After applying the history migration, queue popular stale apps for refetch with `npm run queue-refetch -- --limit=20 --apply`, or target one app with `npm run queue-refetch -- --appid=com.spotify.client --apply`. Without `--apply`, the command is a dry run. It snapshots the current `apps.analysis` row into `app_analyses` before clearing it, so the old result stays available for later comparison.

## Credits
- Oxford SOCIAM Project: <https://sociam.org/mobile-app-x-ray>
- PlatformControl: <https://www.platformcontrol.org>
- Exodus Privacy: <https://exodus-privacy.eu.org/>
- frida-ios-hook: <https://github.com/noobpk/frida-ios-hook>
