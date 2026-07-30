DROP INDEX "idx_browser_session_instances_reconcile";--> statement-breakpoint
ALTER TABLE "browser_session_instances" ALTER COLUMN "pricing_unit_price" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "browser_session_instances" ALTER COLUMN "pricing_unit_size" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "max_credits" SET DEFAULT 1;--> statement-breakpoint
CREATE INDEX "idx_browser_session_instances_reconcile" ON "browser_session_instances" USING btree ("status","updated_at");
