CREATE TABLE "whatsapp_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" varchar(255),
	"twilio_message_sid" varchar(255) NOT NULL,
	"whatsapp_user_link_id" uuid,
	"phone_handle" varchar(32) NOT NULL,
	"from_number" varchar(32) NOT NULL,
	"to_number" varchar(32) NOT NULL,
	"direction" varchar(16) NOT NULL,
	"body" text,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"received_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_thread_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"whatsapp_user_link_id" uuid NOT NULL,
	"root_message_id" varchar(255) NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"last_processed_message_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_handle" varchar(32) NOT NULL,
	"vm0_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_verification_send_cooldowns" (
	"scope" varchar(32) NOT NULL,
	"scope_key" text NOT NULL,
	"last_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_verification_send_cooldowns_pkey" PRIMARY KEY("scope","scope_key")
);
--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_whatsapp_user_link_id_whatsapp_user_links_id_fk" FOREIGN KEY ("whatsapp_user_link_id") REFERENCES "public"."whatsapp_user_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_thread_sessions" ADD CONSTRAINT "whatsapp_thread_sessions_whatsapp_user_link_id_whatsapp_user_links_id_fk" FOREIGN KEY ("whatsapp_user_link_id") REFERENCES "public"."whatsapp_user_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_thread_sessions" ADD CONSTRAINT "whatsapp_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_whatsapp_messages_twilio_message" ON "whatsapp_messages" USING btree ("twilio_message_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_whatsapp_messages_webhook_id" ON "whatsapp_messages" USING btree ("webhook_id") WHERE webhook_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_whatsapp_messages_handle_created" ON "whatsapp_messages" USING btree ("phone_handle","created_at");--> statement-breakpoint
CREATE INDEX "idx_whatsapp_messages_user_link" ON "whatsapp_messages" USING btree ("whatsapp_user_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_whatsapp_thread_sessions_link_root" ON "whatsapp_thread_sessions" USING btree ("whatsapp_user_link_id","root_message_id");--> statement-breakpoint
CREATE INDEX "idx_whatsapp_thread_sessions_user_link" ON "whatsapp_thread_sessions" USING btree ("whatsapp_user_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_whatsapp_user_links_phone_handle" ON "whatsapp_user_links" USING btree ("phone_handle");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_whatsapp_user_links_vm0_org" ON "whatsapp_user_links" USING btree ("vm0_user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_whatsapp_user_links_org" ON "whatsapp_user_links" USING btree ("org_id");