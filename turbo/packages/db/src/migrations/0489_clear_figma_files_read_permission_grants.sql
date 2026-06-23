DELETE FROM user_permission_grants
WHERE connector_ref = 'figma'
  AND permission = 'files:read';
