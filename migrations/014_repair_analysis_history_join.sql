-- One-time repair for findApp's history join (models/Apps.js), which matches
-- app_analyses to apps on exact equality of the `analysed` timestamp. Before
-- this deploy, two independent writer bugs broke that equality for most
-- analysed apps and left the report page showing "Analysed version - Not
-- recorded" for 2788 of 2790 analysed apps:
--
--   Cause 1 (~1,947 apps) -- updateAnalysisWithClient in models/Apps.js used
--   to UPDATE apps SET analysed = NOW() ... RETURNING analysed, then pass
--   that RETURNING value back into the app_analyses INSERT as a query
--   parameter. node-postgres parses a timestamptz into a JS Date, which only
--   has millisecond precision, while Postgres stores microseconds, so the
--   history row was stamped with a truncated timestamp that could never
--   equal apps.analysed again, e.g.:
--     apps.analysed          = 2026-05-19 00:22:37.936317+00
--     app_analyses.analysed  = 2026-05-19 00:22:37.936+00
--   A second consequence: ON CONFLICT (appid, analysed) DO NOTHING could not
--   dedupe against this truncated value, so many apps ended up with a
--   millisecond-precision row and a microsecond-precision row for the same
--   analysis (written later by the refetch/replay snapshot writers, which
--   already build their timestamp in SQL), e.g. at.runtastic.gpssportapp:
--     2026-05-11 23:25:34.019+00     v=14.6.1 src=trackerscan-ios
--     2026-05-11 23:25:34.019238+00  v=14.6.1 src=trackerscan-ios
--   This deploy fixes the writer to source `analysed` from the apps row in
--   SQL instead of round-tripping it through JavaScript (see
--   updateAnalysisWithClient). Step (a) below cleans up the truncated twins
--   this bug already wrote.
--
--   Cause 2 (~817 apps) -- scripts/replay-ios-signatures.js snapshotted the
--   *previous* analysis into app_analyses before overwriting apps.analysis,
--   but never inserted a history row for the *new* analysis it wrote. Every
--   affected app shares apps.analysed = 2026-05-12 23:25:59.056495+00 (one
--   replay run's transaction NOW()), with no history row anywhere near it.
--   This deploy fixes the script to also insert a row for the new analysis
--   (see applyReplayRows). Step (c) below backfills the missing rows this
--   bug left behind.
--
-- Steps (a)-(c) run in order because (b) must not act on rows (a) has
-- already resolved, and (c) must only fill gaps still open after (a) and (b).
-- Nothing here fabricates an analysis that did not happen: (a) only merges
-- true duplicates (same appid, app_version and analysis_source), (b) only
-- retimestamps a history row that is within 1ms of the apps row it already
-- describes, and (c) only inserts from an app's own current analysis column.

-- (a) Dedupe millisecond/microsecond twins written by Cause 1. Keep the
-- microsecond-precision row (apps.analysed always carries microseconds, so
-- that is the row the join can match) and delete the truncated one, but only
-- when the two rows agree on app_version and analysis_source -- i.e. they
-- are the same analysis recorded twice, not two genuine analyses whose
-- timestamps happen to fall within a millisecond of each other.
DELETE FROM app_analyses trunc
USING app_analyses precise
WHERE trunc.appid = precise.appid
  AND trunc.id <> precise.id
  AND trunc.analysed = date_trunc('milliseconds', precise.analysed)
  AND precise.analysed <> date_trunc('milliseconds', precise.analysed)
  AND trunc.app_version IS NOT DISTINCT FROM precise.app_version
  AND trunc.analysis_source IS NOT DISTINCT FROM precise.analysis_source;

-- (b) Realign remaining near-misses: a history row that is within 1ms of
-- apps.analysed but not exactly equal to it (e.g. a truncated row from
-- Cause 1 whose microsecond twin was never written, so step (a) had nothing
-- to dedupe it against). Retimestamp it to the exact apps.analysed value so
-- the join matches. Only one candidate per app may be updated -- DISTINCT ON
-- picks the closest by absolute delta, breaking ties on the highest id (the
-- most recently written row) -- and apps that already have an exact match
-- are excluded so the UPDATE cannot collide with the (appid, analysed)
-- unique index.
WITH candidates AS (
    SELECT DISTINCT ON (apps.appid)
        history.id AS history_id,
        apps.analysed AS target_analysed
    FROM apps
    JOIN app_analyses history
        ON history.appid = apps.appid
        AND history.analysed <> apps.analysed
        AND abs(extract(epoch FROM (history.analysed - apps.analysed))) <= 0.001
    WHERE apps.status = 'analysed'
      AND apps.analysed IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM app_analyses exact
          WHERE exact.appid = apps.appid
            AND exact.analysed = apps.analysed
      )
    ORDER BY apps.appid, abs(extract(epoch FROM (history.analysed - apps.analysed))) ASC, history.id DESC
)
UPDATE app_analyses history
SET analysed = candidates.target_analysed
FROM candidates
WHERE history.id = candidates.history_id;

-- (c) Insert the rows Cause 2 never wrote: apps stuck at status = 'analysed'
-- with no history row at their current apps.analysed, even after (a) and
-- (b). Sourcing mirrors migration 013 and buildAnalysisProvenanceSourceSql in
-- models/Apps.js -- prefer the app_store_cache row keyed on lower(appid),
-- falling back to the apps row's own details/added.
INSERT INTO app_analyses (
    appid,
    analysis,
    analysisversion,
    analysed,
    app_version,
    app_store_updated,
    storefront_details,
    storefront_fetched_at,
    analysis_source,
    success
)
SELECT
    apps.appid,
    apps.analysis,
    apps.analysisversion,
    apps.analysed,
    COALESCE(apps.analysis->>'version', apps.details->>'version'),
    NULLIF(COALESCE(
        NULLIF(cache.details->>'updated', ''),
        apps.details->>'updated'
    ), '')::timestamptz,
    COALESCE(cache.details, apps.details::jsonb),
    COALESCE(cache.fetched_at, apps.added),
    COALESCE(NULLIF(apps.analysis->>'analysis_source', ''), 'legacy'),
    CASE WHEN apps.analysis->>'success' = 'false' THEN false ELSE true END
FROM apps
LEFT JOIN app_store_cache cache
    ON cache.appid_key = lower(apps.appid)
WHERE apps.status = 'analysed'
  AND apps.analysis IS NOT NULL
  AND apps.analysed IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM app_analyses existing
      WHERE existing.appid = apps.appid
        AND existing.analysed = apps.analysed
  )
ON CONFLICT (appid, analysed) DO NOTHING;
