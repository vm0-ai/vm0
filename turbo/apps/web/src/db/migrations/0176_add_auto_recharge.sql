ALTER TABLE org_metadata ADD COLUMN auto_recharge_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE org_metadata ADD COLUMN auto_recharge_threshold bigint;
ALTER TABLE org_metadata ADD COLUMN auto_recharge_amount bigint;
ALTER TABLE org_metadata ADD COLUMN auto_recharge_pending_at timestamptz;
