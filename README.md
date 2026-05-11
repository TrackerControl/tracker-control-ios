# TrackerControl for iOS

TrackerControl for iOS is a web service and analyser pipeline for finding trackers in iOS apps. It is inspired by [TrackerControl for Android](https://trackercontrol.org) and related research on privacy analysis for mobile apps.

The project has two parts:

- A Node.js/Express website where people can search App Store apps and view tracker reports.
- An analyser worker that downloads free App Store apps, analyses them on an actual iPhone, and uploads the results back to the website.

The website also includes jurisdiction analysis, showing which companies and countries control detected tracking infrastructure.

## Features

- Search free iOS apps from the App Store.
- Queue apps for analysis by popularity and staleness.
- Detect embedded tracker signatures and declared tracking domains.
- Store current and historical analysis results.
- Show tracker, permission, and jurisdiction summaries.
- Run the analyser from macOS or a Raspberry Pi host.

Only free App Store apps are queued for analysis. The queue prioritises apps with more stored App Store reviews, then rechecks stale analyses over time.

## Repository Layout

```text
analyser/      App download, install, scan, and upload scripts
lib/           Shared website helpers, including jurisdiction analysis
migrations/    SQL migrations
models/        PostgreSQL access layer
routes/        Express routes and analyser API endpoints
scripts/       Maintenance scripts
views/         Pug templates
public/        Browser assets
static/        Static image assets
```

## Requirements

Website:

- Node.js
- npm
- PostgreSQL
- `DATABASE_URL` pointing at a database with the `apps` table

Analyser:

- An iPhone reachable over SSH
- `trackerscan` installed on the iPhone
- Matching `UPLOAD_PASSWORD` on the website and analyser

## Website Setup

Install dependencies:

```sh
npm install
```

Create a root `.env` file:

```sh
DATABASE_URL=postgres://user:password@host:5432/database
UPLOAD_PASSWORD=change-me
CURRENT_ANALYSIS_VERSION=4
BODY_LIMIT=25mb
PORT=3000
```

Run migrations:

```sh
npm run migrate
```

Start the website:

```sh
npm run watch
```

For production:

```sh
npm run start
```

Open `http://localhost:3000` if `PORT=3000` is set.

## Analyser Setup

Copy the example config:

```sh
cp analyser/.env.example analyser/.env
```

Set at least:

```sh
SERVER=https://your-server.example
UPLOAD_PASSWORD=change-me
ANALYSIS_VERSION=4
ANALYSIS_MODE=trackerscan
TRACKERSCAN_CMD="ssh iphone trackerscan"
TRACKERSCAN_SIGNATURES=/var/mobile/ios_signatures_v2.json
TRACKERSCAN_SIGNATURE_SET=ios-v2
```

Log in to `ipatool` once on the analyser host:

```sh
ipatool auth login
```

Run the queue processor:

```sh
bash analyser/processQueue.sh
```

To analyse one app immediately:

```sh
ONLY_APP_ID=com.spotify.client bash analyser/processQueue.sh
```

The default analysis path uses `trackerscan` and uploads analysis version 4. The legacy Frida flow is still available with:

```sh
ANALYSIS_MODE=frida bash analyser/processQueue.sh
```

The analyser has conservative download and retry limits by default. Tune these in `analyser/.env` only if the host, network, and storage can handle the extra load.

## Raspberry Pi Analyser

The analyser can run on Linux/arm64. A Raspberry Pi needs `node`, `python3`, `unzip`, `zip`, `curl`, `openssh-client`, `libimobiledevice` tools, `ideviceinstaller`, and a Linux arm64 `ipatool`.

Use the installer:

```sh
sudo bash scripts/setup-raspi-analyser.sh
```

See [raspberry-pi-analyser.md](raspberry-pi-analyser.md) for the full setup, including systemd, SSH aliases, `ipatool`, and RAM-backed IPA storage.

## Queue And Operations

The website exposes analyser endpoints:

- `GET /queue` returns the next app to process.
- `GET /ping` marks the analyser online.
- `POST /uploadAnalysis` stores successful analysis results.
- `POST /reportAnalysisFailure` stores failed analysis results.

Analyzer requests authenticate with `Authorization: Bearer $UPLOAD_PASSWORD`.

Health checks:

- `GET /healthz` returns `200` when the website can reach PostgreSQL.
- `GET /healthz/analyser` returns `200` when the analyser has pinged in the last hour.

Useful maintenance commands:

```sh
npm test
npm run queue-status
npm run priority-report -- --limit=20
npm run backup-db
npm run migrate
```

Reset one app for a fresh analysis:

```sh
npm run reset-app -- --appid=com.google.ios.youtube --apply
```

Without `--apply`, the reset command runs as a dry run.

## Analysis Versions

Set `CURRENT_ANALYSIS_VERSION=4` on the website when version 4 results should be treated as current.

The queue will reprocess apps when:

- They have never been analysed.
- Their analysis version is stale.
- Their analysis is older than `STALE_ANALYSIS_DAYS`.
- A previous processing marker has expired after `PROCESSING_TIMEOUT_MINUTES`.

The default stale window is 180 days. The default processing timeout is 120 minutes.

## Credits

- [Oxford SOCIAM Project](https://sociam.org/mobile-app-x-ray)
- [PlatformControl](https://www.platformcontrol.org)
- [Exodus Privacy](https://exodus-privacy.eu.org)
- [frida-ios-hook](https://github.com/noobpk/frida-ios-hook)

## License

This project is licensed under AGPLv3.
