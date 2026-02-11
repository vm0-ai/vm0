-- Add timezone preference column to scopes table
-- NULL means "use UTC" (no default constraint needed)
-- Stores IANA timezone identifiers like "Asia/Shanghai", "America/New_York"

ALTER TABLE scopes ADD COLUMN timezone VARCHAR(50);
