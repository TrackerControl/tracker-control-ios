-- Separate immutable analysis provenance from the mutable App Store cache.
-- This migration follows 012_app_store_cache_retention.sql, which was already
-- deployed with the merged App Store cache change.

ALTER TABLE app_analyses
    ADD COLUMN IF NOT EXISTS storefront_details jsonb,
    ADD COLUMN IF NOT EXISTS storefront_fetched_at timestamptz;

ALTER TABLE app_analyses
    ADD COLUMN IF NOT EXISTS storefront_version_matches boolean
        GENERATED ALWAYS AS (
            (storefront_details->>'version') IS NOT DISTINCT FROM app_version
        ) STORED;

ALTER TABLE app_store_cache
    ADD COLUMN IF NOT EXISTS refresh_attempted_at timestamptz,
    ADD COLUMN IF NOT EXISTS refresh_failures integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refresh_error text;

CREATE INDEX IF NOT EXISTS app_store_cache_fetched_at_idx
    ON app_store_cache (fetched_at);

CREATE INDEX IF NOT EXISTS app_store_cache_retry_eligibility_idx
    ON app_store_cache (refresh_attempted_at, fetched_at)
    WHERE refresh_failures > 0;

-- Ensure every existing app has a latest-known storefront row. Search-only
-- rows remain independent from apps and are handled by the retention job.
INSERT INTO app_store_cache (appid_key, details, fetched_at)
SELECT lower(appid), details::jsonb, added
FROM apps
WHERE details IS NOT NULL
ON CONFLICT (appid_key) DO NOTHING;

-- Preserve the storefront that was known when the currently displayed
-- analysis was written. The generated comparison flag remains authoritative
-- when the storefront version differs from the analysed binary. The two
-- match branches mirror findApp's history join in models/Apps.js: most rows
-- match on apps.analysed, but legacy rows where analysed was never stamped
-- (pre-migration-007 failures) match on the queue-time apps.added instead.
UPDATE app_analyses history
SET storefront_details = apps.details::jsonb,
    storefront_fetched_at = apps.added
FROM apps
WHERE history.appid = apps.appid
  AND apps.details IS NOT NULL
  AND (
      (apps.analysed IS NOT NULL AND history.analysed = apps.analysed)
      OR (apps.analysed IS NULL AND apps.analysis IS NOT NULL AND history.analysed = apps.added)
  );

-- Trackerscan payloads contain the version of the binary that was actually
-- scanned. Legacy payloads without it retain their existing queue snapshot.
UPDATE app_analyses
SET app_version = COALESCE(analysis->>'version', app_version)
WHERE analysis->>'version' IS NOT NULL;
