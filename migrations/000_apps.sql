-- Baseline migration: create the apps table on fresh databases.
-- IF NOT EXISTS makes this a no-op on existing databases where the table
-- predates the migration system. Types deliberately match production
-- (json, timestamp without time zone); the apps_appid_valid CHECK constraint
-- is added later by migration 003.

CREATE TABLE IF NOT EXISTS apps (
    appid text PRIMARY KEY,
    details json,
    analysis json,
    analysisversion integer,
    analysed timestamp without time zone,
    added timestamp without time zone NOT NULL DEFAULT NOW()
);
