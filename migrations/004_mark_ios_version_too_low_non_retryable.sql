UPDATE apps
SET analysis = (
    analysis::jsonb || '{"reason":"ios_version_too_low","retryable":false}'::jsonb
)::json
WHERE analysis IS NOT NULL
  AND analysis->>'success' = 'false'
  AND (
      analysis->>'logs' ILIKE '%DeviceOSVersionTooLow%'
      OR analysis->>'logs' ILIKE '%system version is lower than the minimum OS version%'
  );
