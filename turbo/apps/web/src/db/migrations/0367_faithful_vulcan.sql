CREATE TABLE "imessage_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" varchar(255),
	"agentphone_message_id" varchar(255) NOT NULL,
	"conversation_id" varchar(255),
	"agentphone_agent_id" varchar(255) NOT NULL,
	"imessage_user_link_id" uuid,
	"phone_handle" varchar(32) NOT NULL,
	"from_number" varchar(32) NOT NULL,
	"to_number" varchar(32) NOT NULL,
	"direction" varchar(16) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"body" text,
	"media_url" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"received_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imessage_thread_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imessage_user_link_id" uuid NOT NULL,
	"conversation_id" varchar(255),
	"root_message_id" varchar(255) NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"last_processed_message_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imessage_user_agent_preferences" (
	"vm0_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"selected_compose_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "imessage_user_agent_preferences_pkey" PRIMARY KEY("vm0_user_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "imessage_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_handle" varchar(32) NOT NULL,
	"vm0_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imessage_messages" ADD CONSTRAINT "imessage_messages_imessage_user_link_id_imessage_user_links_id_fk" FOREIGN KEY ("imessage_user_link_id") REFERENCES "public"."imessage_user_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imessage_thread_sessions" ADD CONSTRAINT "imessage_thread_sessions_imessage_user_link_id_imessage_user_links_id_fk" FOREIGN KEY ("imessage_user_link_id") REFERENCES "public"."imessage_user_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imessage_thread_sessions" ADD CONSTRAINT "imessage_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imessage_user_agent_preferences" ADD CONSTRAINT "imessage_user_agent_preferences_selected_compose_id_agent_composes_id_fk" FOREIGN KEY ("selected_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_imessage_messages_agentphone_message" ON "imessage_messages" USING btree ("agentphone_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_imessage_messages_webhook_id" ON "imessage_messages" USING btree ("webhook_id") WHERE webhook_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_imessage_messages_handle_created" ON "imessage_messages" USING btree ("phone_handle","created_at");--> statement-breakpoint
CREATE INDEX "idx_imessage_messages_user_link" ON "imessage_messages" USING btree ("imessage_user_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_imessage_thread_sessions_link_root" ON "imessage_thread_sessions" USING btree ("imessage_user_link_id","root_message_id");--> statement-breakpoint
CREATE INDEX "idx_imessage_thread_sessions_user_link" ON "imessage_thread_sessions" USING btree ("imessage_user_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_imessage_user_links_phone_handle" ON "imessage_user_links" USING btree ("phone_handle");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_imessage_user_links_vm0_org" ON "imessage_user_links" USING btree ("vm0_user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_imessage_user_links_org" ON "imessage_user_links" USING btree ("org_id");