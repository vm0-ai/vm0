CREATE TABLE "feishu_org_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"feishu_open_id" varchar(255) NOT NULL,
	"vm0_user_id" text NOT NULL,
	"feishu_user_name" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_org_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"app_id" varchar(255) NOT NULL,
	"encrypted_app_secret" text NOT NULL,
	"encrypted_verification_token" text NOT NULL,
	"encrypted_encrypt_key" text NOT NULL,
	"default_compose_id" uuid NOT NULL,
	"feishu_tenant_key" varchar(255),
	"feishu_tenant_name" varchar(255),
	"encrypted_tenant_access_token" text,
	"tenant_access_token_expires_at" timestamp,
	"callback_verified_at" timestamp,
	"message_received_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_org_thread_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"feishu_chat_id" varchar(255) NOT NULL,
	"agent_session_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD CONSTRAINT "feishu_org_connections_installation_id_feishu_org_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."feishu_org_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD CONSTRAINT "feishu_org_installations_default_compose_id_agent_composes_id_fk" FOREIGN KEY ("default_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_org_thread_sessions" ADD CONSTRAINT "feishu_org_thread_sessions_connection_id_feishu_org_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."feishu_org_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_org_thread_sessions" ADD CONSTRAINT "feishu_org_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_org_connections_user_installation" ON "feishu_org_connections" USING btree ("feishu_open_id","installation_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_org_connections_vm0_installation" ON "feishu_org_connections" USING btree ("vm0_user_id","installation_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_org_connections_installation" ON "feishu_org_connections" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_org_installations_org" ON "feishu_org_installations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_org_installations_app" ON "feishu_org_installations" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_org_installations_tenant" ON "feishu_org_installations" USING btree ("feishu_tenant_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_org_thread_sessions_conn_chat" ON "feishu_org_thread_sessions" USING btree ("connection_id","feishu_chat_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_org_thread_sessions_connection" ON "feishu_org_thread_sessions" USING btree ("connection_id");