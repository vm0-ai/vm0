CREATE TABLE "usage_pack_pending_snapshot_guards" (
	"org_id" text NOT NULL,
	"pending_snapshot_count" integer NOT NULL,
	CONSTRAINT "chk_usage_pack_pending_snapshot_guard_count" CHECK ("usage_pack_pending_snapshot_guards"."pending_snapshot_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscriptions_pending_org" ON "usage_pack_pending_snapshot_guards" USING btree ("org_id");