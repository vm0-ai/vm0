-- Add platform field to connectors table for platform abstraction
ALTER TABLE connectors
  ADD COLUMN platform VARCHAR(50) NOT NULL DEFAULT 'self-hosted',
  ADD COLUMN nango_connection_id VARCHAR(255);

-- Create index for platform filtering
CREATE INDEX idx_connectors_platform ON connectors(platform);

-- Add comments
COMMENT ON COLUMN connectors.platform IS 'Platform managing this connector: self-hosted or nango';
COMMENT ON COLUMN connectors.nango_connection_id IS 'Nango connection ID (null for self-hosted connectors)';
