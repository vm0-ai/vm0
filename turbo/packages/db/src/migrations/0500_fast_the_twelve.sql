CREATE TABLE "computer_use_authorization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_token_hash" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"source" text NOT NULL,
	"chat_thread_id" uuid,
	"slack_connection_id" uuid,
	"slack_channel_id" text,
	"slack_thread_ts" text,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "computer_use_auth_requests_source_check" CHECK (source IN ('chat', 'slack')),
	CONSTRAINT "computer_use_auth_requests_scope_check" CHECK ((
          source = 'chat'
          AND chat_thread_id IS NOT NULL
          AND slack_connection_id IS NULL
          AND slack_channel_id IS NULL
          AND slack_thread_ts IS NULL
        ) OR (
          source = 'slack'
          AND chat_thread_id IS NULL
          AND slack_connection_id IS NOT NULL
          AND slack_channel_id IS NOT NULL
          AND slack_thread_ts IS NOT NULL
        ))
);
--> statement-breakpoint
ALTER TABLE "slack_org_thread_sessions" ADD COLUMN "computer_use_host_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_use_auth_requests_token_hash" ON "computer_use_authorization_requests" USING btree ("request_token_hash");--> statement-breakpoint
CREATE INDEX "idx_computer_use_auth_requests_org_user" ON "computer_use_authorization_requests" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_computer_use_auth_requests_expires" ON "computer_use_authorization_requests" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "slack_org_thread_sessions" ADD CONSTRAINT "slack_org_thread_sessions_computer_use_host_id_computer_use_hosts_id_fk" FOREIGN KEY ("computer_use_host_id") REFERENCES "public"."computer_use_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_slack_org_thread_sessions_computer_use_host" ON "slack_org_thread_sessions" USING btree ("computer_use_host_id");