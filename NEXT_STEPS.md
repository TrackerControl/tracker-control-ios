# Next Steps

## 1. Commit and Deploy

Commit the backend changes in this repo, then deploy the updated app to Railway.

The database migration has already been applied to the Railway Postgres database. Railway still needs the updated code so future uploads write both:

- `apps.analysis` as the latest website-facing result
- `app_analyses` as append-only history

## 2. Confirm Analyser Configuration

On the analyser machine, confirm `analyser/.env` contains the new analysis mode:

```sh
ANALYSIS_MODE=trackerscan
ANALYSIS_VERSION=3
TRACKERSCAN_CMD="ssh iphone trackerscan"
```

Adjust `TRACKERSCAN_CMD` if the jailbroken phone is reached through a different SSH alias or `iproxy` command.

Also keep conservative download guards enabled:

```sh
MAX_DOWNLOAD_ATTEMPTS=2
MAX_DAILY_DOWNLOAD_BYTES=50000000000
MAX_ATTEMPT_DOWNLOAD_BYTES=3000000000
MAX_APP_SIZE_BYTES=3000000000
CONSECUTIVE_FAILURE_LIMIT=5
CIRCUIT_BREAKER_SLEEP=3600
```

## 3. Run One End-to-End Test

Start with one known app, ideally Spotify because it has an old high-priority analysis:

```sh
npm run queue-refetch -- --appid=com.spotify.client --apply
```

Then run the analyser for one cycle and verify:

- the app downloads successfully
- the IPA installs on the connected iPhone
- `trackerscan` runs over SSH
- `apps.analysis` contains the new latest result
- `app_analyses` contains both the old and new rows
- `analysis.raw_trackerscan` is present in the new result

## 4. Run a Small Batch

After the one-app test works, queue a small batch of popular stale apps:

```sh
npm run queue-refetch -- --limit=10 --apply
```

Monitor analyser logs and network traffic before increasing the batch size.

Use the dry run first when unsure:

```sh
npm run queue-refetch -- --limit=10
```

## 5. Monitor Priority and History

Inspect priority candidates at any time:

```sh
npm run priority-report -- --limit=20
```

Create repeatable JSON backups:

```sh
npm run backup-db
```

For a proper Postgres dump, use the Homebrew libpq tools:

```sh
set -a
. analyser/.env
set +a
/opt/homebrew/opt/libpq/bin/pg_dump --format=custom --no-owner --no-acl --file="backups/postgres-backup-$(date -u +%Y-%m-%dT%H-%M-%SZ).dump" "$DATABASE_URL"
```

## 6. Known Follow-Ups

- Tracker signatures in `trackerscan-ios` may be stale. Defer this until the new pipeline is stable.
- The current App Store metadata cache is still stored in `apps.details`. This is useful for avoiding repeated Apple requests, but the schema remains awkward.
- A cleaner future schema would split app identity, App Store metadata snapshots, analysis history, and queue state into separate tables.
