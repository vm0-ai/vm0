-- Migration 0730: enforce canonical user-message constraints after the
-- compatibility bridge.
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_input_user_message_check";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_draft_user_message_check";--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" DROP CONSTRAINT "zero_agent_drafts_draft_user_message_check";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_input_content_check" CHECK ("chat_events"."event_type" NOT IN ('input.prompt', 'input.rejected')
          OR "chat_events"."content" IS NULL);--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_input_user_message_check" CHECK ("chat_events"."event_type" NOT IN ('input.prompt', 'input.rejected')
          OR "chat_events"."user_message" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_draft_user_message_check" CHECK ("chat_threads"."draft_user_message" IS NOT NULL
          OR (
            COALESCE("chat_threads"."draft_content", '') = ''
            AND COALESCE("chat_threads"."draft_attachments", '[]'::jsonb) = '[]'::jsonb
          ));--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" ADD CONSTRAINT "zero_agent_drafts_draft_user_message_check" CHECK ("zero_agent_drafts"."draft_user_message" IS NOT NULL
          OR (
            COALESCE("zero_agent_drafts"."draft_content", '') = ''
            AND COALESCE("zero_agent_drafts"."draft_attachments", '[]'::jsonb) = '[]'::jsonb
          ));
