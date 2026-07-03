CREATE TABLE "teams_org_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teams_user_id" varchar(255) NOT NULL,
	"teams_tenant_id" varchar(255) NOT NULL,
	"vm0_user_id" text NOT NULL,
	"teams_user_display_name" varchar(255),
	"teams_user_principal_name" varchar(255),
	"dm_welcome_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams_org_installations" (
	"teams_tenant_id" varchar(255) PRIMARY KEY NOT NULL,
	"teams_tenant_name" varchar(255),
	"teams_team_id" varchar(255),
	"teams_team_name" varchar(255),
	"teams_app_id" varchar(255),
	"bot_id" varchar(255),
	"bot_name" varchar(255),
	"service_url" text,
	"org_id" text,
	"installed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams_org_thread_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"teams_conversation_id" varchar(255) NOT NULL,
	"teams_channel_id" varchar(255),
	"teams_thread_id" varchar(255) NOT NULL,
	"agent_session_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams_user_agent_preferences" (
	"vm0_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"selected_compose_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "teams_user_agent_preferences_pkey" PRIMARY KEY("vm0_user_id","org_id")
);
--> statement-breakpoint
ALTER TABLE "teams_org_connections" ADD CONSTRAINT "teams_org_connections_teams_tenant_id_teams_org_installations_teams_tenant_id_fk" FOREIGN KEY ("teams_tenant_id") REFERENCES "public"."teams_org_installations"("teams_tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_org_thread_sessions" ADD CONSTRAINT "teams_org_thread_sessions_connection_id_teams_org_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."teams_org_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_org_thread_sessions" ADD CONSTRAINT "teams_org_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences" ADD CONSTRAINT "teams_user_agent_preferences_selected_compose_id_agent_composes_id_fk" FOREIGN KEY ("selected_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_org_connections_user_tenant" ON "teams_org_connections" USING btree ("teams_user_id","teams_tenant_id");--> statement-breakpoint
CREATE INDEX "idx_teams_org_connections_vm0_tenant" ON "teams_org_connections" USING btree ("vm0_user_id","teams_tenant_id");--> statement-breakpoint
CREATE INDEX "idx_teams_org_connections_tenant" ON "teams_org_connections" USING btree ("teams_tenant_id");--> statement-breakpoint
CREATE INDEX "idx_teams_org_installations_org" ON "teams_org_installations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_org_installations_org_unique" ON "teams_org_installations" USING btree ("org_id") WHERE org_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_org_thread_sessions_conn_conversation_thread" ON "teams_org_thread_sessions" USING btree ("connection_id","teams_conversation_id","teams_thread_id");--> statement-breakpoint
CREATE INDEX "idx_teams_org_thread_sessions_connection" ON "teams_org_thread_sessions" USING btree ("connection_id");
