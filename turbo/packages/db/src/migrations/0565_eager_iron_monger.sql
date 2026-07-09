ALTER TABLE "computer_use_authorization_requests" DROP CONSTRAINT "computer_use_auth_requests_source_check";--> statement-breakpoint
ALTER TABLE "computer_use_authorization_requests" DROP CONSTRAINT "computer_use_auth_requests_scope_check";--> statement-breakpoint
ALTER TABLE "org_metadata" ALTER COLUMN "tier" SET DEFAULT 'limited-free-1';--> statement-breakpoint
ALTER TABLE "computer_use_authorization_requests" ADD COLUMN "teams_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "computer_use_authorization_requests" ADD COLUMN "teams_conversation_id" text;--> statement-breakpoint
ALTER TABLE "computer_use_authorization_requests" ADD COLUMN "teams_thread_id" text;--> statement-breakpoint
ALTER TABLE "teams_org_thread_sessions" ADD COLUMN "computer_use_host_id" uuid;--> statement-breakpoint
ALTER TABLE "teams_org_thread_sessions" ADD CONSTRAINT "teams_org_thread_sessions_computer_use_host_id_computer_use_hosts_id_fk" FOREIGN KEY ("computer_use_host_id") REFERENCES "public"."computer_use_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_teams_org_thread_sessions_computer_use_host" ON "teams_org_thread_sessions" USING btree ("computer_use_host_id");--> statement-breakpoint
ALTER TABLE "computer_use_authorization_requests" ADD CONSTRAINT "computer_use_auth_requests_source_check" CHECK (source IN ('chat', 'slack', 'teams'));--> statement-breakpoint
ALTER TABLE "computer_use_authorization_requests" ADD CONSTRAINT "computer_use_auth_requests_scope_check" CHECK ((
          source = 'chat'
          AND chat_thread_id IS NOT NULL
          AND slack_connection_id IS NULL
          AND slack_channel_id IS NULL
          AND slack_thread_ts IS NULL
          AND teams_connection_id IS NULL
          AND teams_conversation_id IS NULL
          AND teams_thread_id IS NULL
        ) OR (
          source = 'slack'
          AND chat_thread_id IS NULL
          AND slack_connection_id IS NOT NULL
          AND slack_channel_id IS NOT NULL
          AND slack_thread_ts IS NOT NULL
          AND teams_connection_id IS NULL
          AND teams_conversation_id IS NULL
          AND teams_thread_id IS NULL
        ) OR (
          source = 'teams'
          AND chat_thread_id IS NULL
          AND slack_connection_id IS NULL
          AND slack_channel_id IS NULL
          AND slack_thread_ts IS NULL
          AND teams_connection_id IS NOT NULL
          AND teams_conversation_id IS NOT NULL
          AND teams_thread_id IS NOT NULL
        ));