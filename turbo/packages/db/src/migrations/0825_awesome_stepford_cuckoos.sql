CREATE TABLE "chat_agent_run_context" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_chat_thread_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'slack',
          'feishu',
          'teams',
          'telegram',
          'github',
          'agentphone',
          'automation',
          'goal',
          'morning_brief',
          'agent_run'
        ));