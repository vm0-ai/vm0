DELETE FROM "connector_catalog_compatibility_evaluation"
WHERE jsonb_typeof("filtered_auth_methods") = 'array';
