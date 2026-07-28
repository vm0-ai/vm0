ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_input_user_message_check" CHECK ("chat_messages"."event_type" NOT IN ('input.prompt', 'input.rejected')
          OR "chat_messages"."structured_prompt" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_draft_user_message_check" CHECK ("chat_threads"."draft_structured_prompt" IS NOT NULL
          OR (
            COALESCE("chat_threads"."draft_content", '') = ''
            AND COALESCE("chat_threads"."draft_attachments", '[]'::jsonb) = '[]'::jsonb
          ));--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" ADD CONSTRAINT "zero_agent_drafts_draft_user_message_check" CHECK ("zero_agent_drafts"."draft_structured_prompt" IS NOT NULL
          OR (
            COALESCE("zero_agent_drafts"."draft_content", '') = ''
            AND COALESCE("zero_agent_drafts"."draft_attachments", '[]'::jsonb) = '[]'::jsonb
          ));