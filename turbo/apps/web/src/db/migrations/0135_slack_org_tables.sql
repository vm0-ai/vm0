CREATE TABLE "slack_org_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_user_id" varchar(255) NOT NULL,
	"slack_workspace_id" varchar(255) NOT NULL,
	"vm0_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"dm_welcome_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_org_installations" (
	"slack_workspace_id" varchar(255) PRIMARY KEY NOT NULL,
	"slack_workspace_name" varchar(255),
	"org_id" text,
	"encrypted_bot_token" text NOT NULL,
	"bot_user_id" varchar(255) NOT NULL,
	"installed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_org_pending_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar(64) NOT NULL,
	"slack_workspace_id" varchar(255) NOT NULL,
	"slack_channel_id" varchar(255) NOT NULL,
	"slack_thread_ts" varchar(255) NOT NULL,
	"slack_message_ts" varchar(255),
	"connection_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"compose_id" uuid NOT NULL,
	"agent_name" varchar(255) NOT NULL,
	"session_id" uuid,
	"questions" jsonb NOT NULL,
	"answered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_org_thread_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"slack_channel_id" varchar(255) NOT NULL,
	"slack_thread_ts" varchar(255) NOT NULL,
	"agent_session_id" uuid,
	"last_processed_message_ts" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_org_connections" ADD CONSTRAINT "slack_org_connections_slack_workspace_id_slack_org_installations_slack_workspace_id_fk" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_org_installations"("slack_workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_org_pending_questions" ADD CONSTRAINT "slack_org_pending_questions_connection_id_slack_org_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."slack_org_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_org_pending_questions" ADD CONSTRAINT "slack_org_pending_questions_compose_id_agent_composes_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_org_pending_questions" ADD CONSTRAINT "slack_org_pending_questions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_org_thread_sessions" ADD CONSTRAINT "slack_org_thread_sessions_connection_id_slack_org_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."slack_org_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_org_thread_sessions" ADD CONSTRAINT "slack_org_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_org_connections_user_workspace" ON "slack_org_connections" USING btree ("slack_user_id","slack_workspace_id");--> statement-breakpoint
CREATE INDEX "idx_slack_org_connections_workspace" ON "slack_org_connections" USING btree ("slack_workspace_id");--> statement-breakpoint
CREATE INDEX "idx_slack_org_connections_vm0_user_org" ON "slack_org_connections" USING btree ("vm0_user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_slack_org_installations_org" ON "slack_org_installations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_org_installations_org_unique" ON "slack_org_installations" USING btree ("org_id") WHERE org_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_slack_org_pending_questions_run_id" ON "slack_org_pending_questions" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_org_thread_sessions_conn_channel_thread" ON "slack_org_thread_sessions" USING btree ("connection_id","slack_channel_id","slack_thread_ts");--> statement-breakpoint
CREATE INDEX "idx_slack_org_thread_sessions_connection" ON "slack_org_thread_sessions" USING btree ("connection_id");