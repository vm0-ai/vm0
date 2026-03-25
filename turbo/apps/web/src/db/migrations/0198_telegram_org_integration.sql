-- Add org-level integration support to telegram_installations
-- Adds org_id for org-scoped binding and enabled toggle for admin control

ALTER TABLE "telegram_installations" ADD COLUMN "org_id" text;
ALTER TABLE "telegram_installations" ADD COLUMN "enabled" boolean NOT NULL DEFAULT true;

CREATE INDEX "idx_telegram_installations_org" ON "telegram_installations" USING btree ("org_id");
CREATE UNIQUE INDEX "idx_telegram_installations_org_unique" ON "telegram_installations" ("org_id") WHERE org_id IS NOT NULL;
