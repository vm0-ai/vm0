-- vm0:non-transactional
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_usage_pack_changes_current_user_replacement" ON "usage_pack_allocation_changes" USING btree ("org_id","user_id") WHERE ("usage_pack_allocation_changes"."subscription_change_id" IS NULL AND "usage_pack_allocation_changes"."status" IN ('previewed', 'applying', 'pending_payment')) OR "usage_pack_allocation_changes"."status" IN ('scheduled', 'applied');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "uq_usage_pack_changes_current_user";--> statement-breakpoint
ALTER INDEX IF EXISTS "uq_usage_pack_changes_current_user_replacement" RENAME TO "uq_usage_pack_changes_current_user";
