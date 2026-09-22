-- Record absence from the storefront separately from a refresh failure.
-- Apple answers a bundle ID it does not list in the requested storefront with
-- an empty result set, which is also how it answers one that does not exist
-- anywhere. Before this migration the refresher counted that as a failure, so
-- a storefront-withdrawn app sat in the failure backoff indefinitely and the
-- report page could not say why its metadata had stopped updating.

ALTER TABLE app_store_cache
    ADD COLUMN IF NOT EXISTS storefront_absent_since timestamptz;

-- Rows the refresher has already recorded as absent. The first absent
-- attempt was not recorded, so the latest attempt is the best available
-- lower bound.
UPDATE app_store_cache
SET storefront_absent_since = COALESCE(refresh_attempted_at, NOW()),
    refresh_failures = 0,
    refresh_error = NULL
WHERE refresh_error = 'app_not_found';
