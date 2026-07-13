-- Deduplicate app_analyses history rows and enforce a unique (appid, analysed)
-- constraint so concurrent snapshot/history writers can rely on ON CONFLICT
-- instead of a race-prone NOT EXISTS guard.

-- Remove duplicate rows, keeping the lowest id per (appid, analysed) pair.
DELETE FROM app_analyses a
USING app_analyses b
WHERE a.appid = b.appid
  AND a.analysed = b.analysed
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS app_analyses_appid_analysed_unique
    ON app_analyses (appid, analysed);
