ALTER TABLE "telegram_installations" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "telegram_installations" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_telegram_installations_org" ON "telegram_installations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_installations_org_unique" ON "telegram_installations" USING btree ("org_id") WHERE org_id IS NOT NULL;