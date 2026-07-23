-- The Memory Viewer and activity readers were retired before this migration.
-- Keep this cleanup behind the production drain gate for the old API fleet.
DROP TABLE "memory_change_items" CASCADE;--> statement-breakpoint
DROP TABLE "memory_change_summaries" CASCADE;--> statement-breakpoint
UPDATE "user_feature_switches"
SET
  "switches" = "switches" - 'memoryViewer',
  "updated_at" = NOW()
WHERE "switches" ? 'memoryViewer';
