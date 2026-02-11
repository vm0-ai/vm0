-- Add timezone preference column to users table
-- NULL means "use UTC" (no default constraint needed)
-- Stores IANA timezone identifiers like "Asia/Shanghai", "America/New_York"

ALTER TABLE users ADD COLUMN timezone VARCHAR(50);
