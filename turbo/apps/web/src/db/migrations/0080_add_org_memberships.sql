-- Organization memberships table
-- Tracks which users are members of which organization scopes

CREATE TABLE org_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(scope_id, user_id)
);

CREATE INDEX idx_org_memberships_scope ON org_memberships(scope_id);
CREATE INDEX idx_org_memberships_user ON org_memberships(user_id);
