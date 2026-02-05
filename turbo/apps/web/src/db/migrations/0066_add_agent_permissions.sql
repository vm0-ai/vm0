-- Agent Permissions table (ACL)
-- Stores access control entries for agent composes

CREATE TABLE agent_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_compose_id UUID NOT NULL REFERENCES agent_composes(id) ON DELETE CASCADE,
  grantee_type VARCHAR(16) NOT NULL,
  grantee_email TEXT,
  permission VARCHAR(32) NOT NULL DEFAULT 'run_view',
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_permissions_compose_type_email_unique
    UNIQUE(agent_compose_id, grantee_type, grantee_email)
);

CREATE INDEX idx_agent_permissions_compose ON agent_permissions(agent_compose_id);
CREATE INDEX idx_agent_permissions_email ON agent_permissions(grantee_email)
  WHERE grantee_email IS NOT NULL;
