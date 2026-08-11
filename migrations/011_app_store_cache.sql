-- Cache App Store search metadata separately from apps. A cache entry does not
-- enqueue an analysis; a later search refreshes the stored metadata.

CREATE TABLE app_store_cache (
    appid_key text PRIMARY KEY,
    details jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT app_store_cache_lowercase_key CHECK (appid_key = lower(appid_key))
);
