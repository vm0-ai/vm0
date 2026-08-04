CREATE TABLE "chat_agentphone_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"message_text" text,
	"thread_context" text,
	"message_id" text,
	"root_message_id" text,
	"conversation_id" text,
	"channel" text,
	"is_group" boolean,
	"phone_handle" text,
	"from_number" text,
	"to_number" text,
	"user_link_id" uuid,
	"agentphone_agent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
ALTER TABLE "chat_agentphone_context" ADD CONSTRAINT "chat_agentphone_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'slack',
          'feishu',
          'teams',
          'telegram',
          'github',
          'agentphone',
          'automation',
          'goal',
          'morning_brief'
        ));
