CREATE VIEW "agent_drafts" AS
SELECT
  "user_id",
  "org_id",
  "agent_id",
  "draft_user_message",
  "draft_attachments",
  "created_at",
  "updated_at"
FROM "zero_agent_drafts";
