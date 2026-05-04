CREATE TABLE IF NOT EXISTS app_analyses (
    id bigserial PRIMARY KEY,
    appid text NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
    analysis json NOT NULL,
    analysisversion integer,
    analysed timestamp without time zone NOT NULL DEFAULT NOW(),
    app_version text,
    app_store_updated timestamp without time zone,
    analysis_source text,
    success boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS app_analyses_appid_analysed_idx
    ON app_analyses (appid, analysed DESC);

CREATE INDEX IF NOT EXISTS app_analyses_popular_refetch_idx
    ON app_analyses (analysisversion, analysed DESC);

INSERT INTO app_analyses (
    appid,
    analysis,
    analysisversion,
    analysed,
    app_version,
    app_store_updated,
    analysis_source,
    success
)
SELECT
    appid,
    analysis,
    analysisversion,
    COALESCE(analysed, added, NOW()),
    details->>'version',
    NULLIF(details->>'updated', '')::timestamp,
    COALESCE(analysis->>'analysis_source', 'legacy'),
    COALESCE((analysis->>'success')::boolean, true)
FROM apps
WHERE analysis IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM app_analyses existing
      WHERE existing.appid = apps.appid
        AND existing.analysed = COALESCE(apps.analysed, apps.added, NOW())
  );
