UPDATE apps
SET analysis = (
    analysis::jsonb || '{"reason":"app_not_found","retryable":false}'::jsonb
)::json
WHERE analysis IS NOT NULL
  AND analysis->>'success' = 'false'
  AND analysis->>'logs' ILIKE '%app not found%';
