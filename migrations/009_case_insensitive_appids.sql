-- The App Store treats bundle IDs case-insensitively; enforce that in the
-- database. Merge rows whose appid differs only by case, then add a unique
-- index on lower(appid).

-- Rank rows within each case-insensitive duplicate group. The keeper (rn = 1)
-- prefers status = 'analysed', then the most recent analysis, then the
-- earliest-added row; appid is a final tie-breaker for determinism.
CREATE TEMP TABLE apps_case_dupes ON COMMIT DROP AS
SELECT
    appid,
    lower(appid) AS lower_appid,
    row_number() OVER (
        PARTITION BY lower(appid)
        ORDER BY
            (status = 'analysed') DESC,
            analysed DESC NULLS LAST,
            added ASC,
            appid ASC
    ) AS rn
FROM apps
WHERE lower(appid) IN (
    SELECT lower(appid)
    FROM apps
    GROUP BY lower(appid)
    HAVING count(*) > 1
);

-- Before repointing history rows to the keeper, drop rows that would collide
-- on the (appid, analysed) unique index once every appid in the group becomes
-- the keeper's: keep the lowest id per (group, analysed) pair.
DELETE FROM app_analyses a
USING apps_case_dupes ma, app_analyses b, apps_case_dupes mb
WHERE ma.appid = a.appid
    AND mb.appid = b.appid
    AND ma.lower_appid = mb.lower_appid
    AND a.analysed = b.analysed
    AND a.id > b.id;

-- Repoint the losers' remaining history rows to the keeper.
UPDATE app_analyses a
SET appid = keeper.appid
FROM apps_case_dupes loser
JOIN apps_case_dupes keeper
    ON keeper.lower_appid = loser.lower_appid AND keeper.rn = 1
WHERE a.appid = loser.appid
    AND loser.rn > 1;

-- Drop the loser apps rows (their history has been moved to the keeper).
DELETE FROM apps a
USING apps_case_dupes loser
WHERE loser.rn > 1
    AND a.appid = loser.appid;

CREATE UNIQUE INDEX IF NOT EXISTS apps_appid_lower_unique
    ON apps (lower(appid));
