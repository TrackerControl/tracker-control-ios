UPDATE apps
SET analysis = (
    analysis::jsonb || '{"reason":"paid_app","retryable":false}'::jsonb
)::json
WHERE analysis IS NOT NULL
  AND analysis->>'success' = 'false'
  AND analysis->>'logs' ILIKE '%purchasing paid apps is not supported%';
