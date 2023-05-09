update apps set analysis = null where (analysis->'success')::text = 'false'
