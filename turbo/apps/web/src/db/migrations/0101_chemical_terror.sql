CREATE TABLE "slack_pending_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar(64) NOT NULL,
	"slack_workspace_id" varchar(64) NOT NULL,
	"slack_channel_id" varchar(64) NOT NULL,
	"slack_thread_ts" varchar(64) NOT NULL,
	"slack_message_ts" varchar(64),
	"user_link_id" uuid NOT NULL,
	"compose_id" uuid NOT NULL,
	"agent_name" varchar(128) NOT NULL,
	"session_id" uuid,
	"questions" jsonb NOT NULL,
	"answered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_slack_pending_questions_run_id" ON "slack_pending_questions" USING btree ("run_id");