UPDATE "feishu_org_installations"
SET "setup_completed_at" = "message_received_at"
WHERE "message_received_at" IS NOT NULL;
