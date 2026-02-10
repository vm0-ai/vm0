-- Organization invitations table
-- Stores invite links for joining organizations

CREATE TABLE org_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  used_by TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_org_invitations_token ON org_invitations(token);
CREATE INDEX idx_org_invitations_scope ON org_invitations(scope_id);
