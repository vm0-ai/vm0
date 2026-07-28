-- Copy the complete draft document into the canonical column for rows created
-- before the single-column writer was deployed. Rows written by that writer
-- intentionally have a NULL compatibility column and must not be overwritten.
UPDATE "chat_threads"
SET "draft_structured_prompt" = "draft_structured_prompt_with_feedback"
WHERE "draft_structured_prompt_with_feedback" IS NOT NULL
  AND "draft_structured_prompt" IS DISTINCT FROM "draft_structured_prompt_with_feedback";--> statement-breakpoint

UPDATE "zero_agent_drafts"
SET "draft_structured_prompt" = "draft_structured_prompt_with_feedback"
WHERE "draft_structured_prompt_with_feedback" IS NOT NULL
  AND "draft_structured_prompt" IS DISTINCT FROM "draft_structured_prompt_with_feedback";
