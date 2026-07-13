-- Tie every processing assignment to a one-use random claim token. Completion
-- compares this token before writing so a timed-out or explicitly reset worker
-- cannot overwrite the result of a newer assignment.

ALTER TABLE apps
    ADD COLUMN analysis_claim_token uuid;

-- Existing processing rows predate claim tokens. Requeue them rather than
-- accepting an unverifiable completion during rollout.
UPDATE apps
SET status = 'queued',
    processing_started = NULL
WHERE status = 'processing';

ALTER TABLE apps
    ADD CONSTRAINT apps_processing_claim_token_check CHECK (
        (status = 'processing' AND analysis_claim_token IS NOT NULL)
        OR (status <> 'processing' AND analysis_claim_token IS NULL)
    );
