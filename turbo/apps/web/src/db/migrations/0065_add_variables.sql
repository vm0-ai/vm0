-- Add variables table for non-sensitive configuration storage
-- Unlike secrets, variable values are stored in plaintext

CREATE TABLE variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE UNIQUE INDEX idx_variables_scope_name ON variables(scope_id, name);
CREATE INDEX idx_variables_scope ON variables(scope_id);
