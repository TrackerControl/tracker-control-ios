-- Move queue/analysis state out of the analysis JSON payload into real columns.
-- The analysis column keeps the raw analyser payload untouched (so the website's
-- failure display and the Raspberry Pi HTTP contract stay byte-identical);
-- scheduling state now lives in status/processing_started/failure_* columns.
--
-- Additive and backward-compatible: the currently deployed code ignores these
-- columns entirely, and the defaults keep new rows valid until the new code boots.

ALTER TABLE apps
    ADD COLUMN status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'analysed', 'failed')),
    ADD COLUMN processing_started timestamptz,
    ADD COLUMN failure_reason text,
    ADD COLUMN failure_retryable boolean;

-- Backfill from the JSON state previously embedded in analysis.
-- Order matters: the in-flight processing indicator also carries
-- success=false, so it must be classified before the failed branch.
--
-- Timestamps are validated with a regex before casting so a malformed
-- analysis->>'timestamp' cannot abort the whole migration; unparseable
-- values fall back to NOW() so the processing lock still expires normally.
UPDATE apps
SET
    status = CASE
        WHEN analysis IS NULL THEN 'queued'
        WHEN analysis->>'logs' = 'Processing in progress' THEN 'processing'
        WHEN analysis->>'success' = 'false' THEN 'failed'
        ELSE 'analysed'
    END,
    processing_started = CASE
        WHEN analysis->>'logs' = 'Processing in progress' THEN
            CASE
                WHEN analysis->>'timestamp' ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}'
                    THEN (analysis->>'timestamp')::timestamptz
                ELSE NOW()
            END
    END,
    failure_reason = CASE
        WHEN COALESCE(analysis->>'logs', '') <> 'Processing in progress'
            AND analysis->>'success' = 'false'
            THEN analysis->>'reason'
    END,
    failure_retryable = CASE
        WHEN COALESCE(analysis->>'logs', '') <> 'Processing in progress'
            AND analysis->>'success' = 'false'
            THEN COALESCE(analysis->>'retryable', 'true') <> 'false'
    END;

-- Indexes supporting the queue scan (models/Apps.js nextApp / countQueue).
-- A partial index per hot status keeps the candidate lookup cheap.
CREATE INDEX IF NOT EXISTS apps_status_idx
    ON apps (status);

CREATE INDEX IF NOT EXISTS apps_queued_added_idx
    ON apps (added ASC)
    WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS apps_processing_started_idx
    ON apps (processing_started)
    WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS apps_failed_retryable_idx
    ON apps (status)
    WHERE status = 'failed' AND failure_retryable;

CREATE INDEX IF NOT EXISTS apps_analysed_version_idx
    ON apps (analysisversion, analysed)
    WHERE status = 'analysed';
