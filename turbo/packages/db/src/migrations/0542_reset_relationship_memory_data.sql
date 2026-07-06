DELETE FROM "relationship_sync_jobs";
--> statement-breakpoint
DELETE FROM "relationship_backfill_jobs";
--> statement-breakpoint
DELETE FROM "relationship_item_sources";
--> statement-breakpoint
DELETE FROM "relationship_interactions";
--> statement-breakpoint
DELETE FROM "relationship_items";
--> statement-breakpoint
DELETE FROM "relationship_states";
--> statement-breakpoint
DELETE FROM "relationship_entities";
--> statement-breakpoint
UPDATE "relationship_memory_settings"
SET
  "bootstrap_status" = CASE
    WHEN "enabled" THEN 'pending'
    ELSE 'idle'
  END,
  "last_sync_at" = NULL,
  "last_error" = NULL,
  "updated_at" = now();
