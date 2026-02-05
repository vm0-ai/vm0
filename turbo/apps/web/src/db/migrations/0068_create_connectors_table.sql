-- Migration: Create connectors table for third-party service connections
-- Stores connector metadata; secrets stored separately in secrets table with type="connector"

CREATE TABLE IF NOT EXISTS connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  auth_method VARCHAR(50) NOT NULL,
  external_id VARCHAR(255),
  external_username VARCHAR(255),
  external_email VARCHAR(255),
  oauth_scopes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One connector per type per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_scope_type ON connectors (scope_id, type);

-- Index for listing user's connectors
CREATE INDEX IF NOT EXISTS idx_connectors_scope ON connectors (scope_id);
