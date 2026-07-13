UPDATE apps
SET analysis = (
    COALESCE(analysis::jsonb, '{}'::jsonb) || jsonb_build_object(
        'success', false,
        'reason', 'invalid_bundle_id',
        'retryable', false,
        'logs', 'Invalid App Store bundle ID quarantined by migration 003.'
    )
)::json
WHERE length(appid) > 255
   OR appid !~ '^[A-Za-z0-9][A-Za-z0-9.-]*$'
   OR appid ~ '[.]$';

ALTER TABLE apps
ADD CONSTRAINT apps_appid_valid
CHECK (
    length(appid) BETWEEN 1 AND 255
    AND appid ~ '^[A-Za-z0-9][A-Za-z0-9.-]*$'
    AND appid !~ '[.]$'
) NOT VALID;
