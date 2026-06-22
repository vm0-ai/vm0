DELETE FROM user_permission_grants
WHERE connector_ref IN (
  'gmail',
  'google-analytics',
  'google-calendar',
  'google-docs',
  'google-drive',
  'google-meet',
  'google-search-console',
  'google-sheets',
  'youtube'
);
