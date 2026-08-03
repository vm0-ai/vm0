CREATE TABLE "chat_morning_brief_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"timezone" text,
	"triggered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
ALTER TABLE "chat_morning_brief_context" ADD CONSTRAINT "chat_morning_brief_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'slack',
          'feishu',
          'teams',
          'telegram',
          'github',
          'automation',
          'goal',
          'morning_brief'
        ));