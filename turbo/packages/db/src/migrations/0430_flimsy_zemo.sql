UPDATE "memory_change_items"
SET "diff" = jsonb_set(
  jsonb_set(
    "diff",
    '{beforeExists}',
    CASE WHEN "kind" = 'learned' THEN 'false'::jsonb ELSE 'true'::jsonb END,
    true
  ),
  '{afterExists}',
  CASE WHEN "kind" = 'forgotten' THEN 'false'::jsonb ELSE 'true'::jsonb END,
  true
);--> statement-breakpoint
ALTER TABLE "memory_change_items" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "memory_change_items" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "memory_change_items" DROP COLUMN "description";
