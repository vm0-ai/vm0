-- This migration performs catalog-only DDL. PostgreSQL still needs brief
-- metadata locks, so fail instead of queueing behind production traffic.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

DROP TRIGGER "bridge_chat_user_message_0727" ON "chat_events";--> statement-breakpoint
DROP TRIGGER "bridge_chat_thread_draft_user_message_0727" ON "chat_threads";--> statement-breakpoint
DROP TRIGGER "bridge_agent_draft_user_message_0727" ON "zero_agent_drafts";--> statement-breakpoint
DROP FUNCTION "bridge_chat_user_message_0727"();--> statement-breakpoint
DROP FUNCTION "bridge_draft_user_message_0727"();--> statement-breakpoint

ALTER TABLE "chat_events" DROP COLUMN "structured_prompt";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "draft_structured_prompt";--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" DROP COLUMN "draft_structured_prompt";
