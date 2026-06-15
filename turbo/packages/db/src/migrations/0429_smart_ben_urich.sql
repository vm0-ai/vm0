DELETE FROM "memory_change_summaries";--> statement-breakpoint
ALTER TABLE "memory_change_items" ADD COLUMN "diff" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_change_items" DROP COLUMN "before_snippet";--> statement-breakpoint
ALTER TABLE "memory_change_items" DROP COLUMN "after_snippet";
