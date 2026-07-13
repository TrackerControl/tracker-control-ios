-- Modernise column types: json -> jsonb and timestamp -> timestamptz.
-- Historical timestamps were written in UTC, so reinterpret them as UTC.
-- schema_migrations is deliberately left untouched.

ALTER TABLE apps
    ALTER COLUMN details TYPE jsonb USING details::jsonb,
    ALTER COLUMN analysis TYPE jsonb USING analysis::jsonb,
    ALTER COLUMN added TYPE timestamptz USING (added AT TIME ZONE 'UTC'),
    ALTER COLUMN analysed TYPE timestamptz USING (analysed AT TIME ZONE 'UTC');

ALTER TABLE app_analyses
    ALTER COLUMN analysis TYPE jsonb USING analysis::jsonb,
    ALTER COLUMN analysed TYPE timestamptz USING (analysed AT TIME ZONE 'UTC'),
    ALTER COLUMN app_store_updated TYPE timestamptz USING (app_store_updated AT TIME ZONE 'UTC');
