DROP VIEW "agent_drafts";
--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" RENAME TO "agent_drafts";
--> statement-breakpoint
ALTER TABLE "agent_drafts" RENAME CONSTRAINT "zero_agent_drafts_agent_id_agents_id_fk" TO "agent_drafts_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_drafts" RENAME CONSTRAINT "zero_agent_drafts_draft_user_message_check" TO "agent_drafts_draft_user_message_check";
--> statement-breakpoint
ALTER INDEX "idx_zero_agent_drafts_user_org_agent" RENAME TO "idx_agent_drafts_user_org_agent";
--> statement-breakpoint
CREATE VIEW "zero_agent_drafts" AS
SELECT
  "user_id",
  "org_id",
  "agent_id",
  "draft_user_message",
  "draft_attachments",
  "created_at",
  "updated_at"
FROM "agent_drafts";
