CREATE TABLE "chat_github_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"subject_number" integer NOT NULL,
	"subject_kind" text NOT NULL,
	"trigger_comment_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_context_subject_kind_check" CHECK ("chat_github_context"."subject_kind" IN ('issue', 'pull_request'))
);
--> statement-breakpoint
CREATE TABLE "chat_teams_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"team_id" text,
	"channel_id" text,
	"conversation_id" text NOT NULL,
	"conversation_type" text,
	"activity_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_telegram_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"is_dm" boolean NOT NULL,
	"message_thread_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
ALTER TABLE "chat_slack_context" ALTER COLUMN "message_permalink" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "message_ts" text;--> statement-breakpoint
ALTER TABLE "chat_github_context" ADD CONSTRAINT "chat_github_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD CONSTRAINT "chat_teams_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ADD CONSTRAINT "chat_telegram_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'slack',
          'feishu',
          'teams',
          'telegram',
          'github',
          'automation',
          'goal'
        ));
