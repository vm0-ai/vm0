CREATE TABLE "telegram_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_bot_id" varchar(255) NOT NULL,
	"bot_username" varchar(255),
	"encrypted_bot_token" text NOT NULL,
	"webhook_secret" varchar(255) NOT NULL,
	"default_compose_id" uuid NOT NULL,
	"admin_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_installations_telegram_bot_id_unique" UNIQUE("telegram_bot_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"chat_id" varchar(255) NOT NULL,
	"message_id" varchar(255) NOT NULL,
	"from_user_id" varchar(255) NOT NULL,
	"from_username" varchar(255),
	"text" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_thread_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_link_id" uuid NOT NULL,
	"chat_id" varchar(255) NOT NULL,
	"root_message_id" varchar(255) NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"last_processed_message_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" varchar(255) NOT NULL,
	"installation_id" uuid NOT NULL,
	"vm0_user_id" text NOT NULL,
	"dm_welcome_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_installations" ADD CONSTRAINT "telegram_installations_default_compose_id_agent_composes_id_fk" FOREIGN KEY ("default_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_installation_id_telegram_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."telegram_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_thread_sessions" ADD CONSTRAINT "telegram_thread_sessions_telegram_user_link_id_telegram_user_links_id_fk" FOREIGN KEY ("telegram_user_link_id") REFERENCES "public"."telegram_user_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_thread_sessions" ADD CONSTRAINT "telegram_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_user_links" ADD CONSTRAINT "telegram_user_links_installation_id_telegram_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."telegram_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_messages_unique" ON "telegram_messages" USING btree ("installation_id","chat_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_telegram_messages_chat" ON "telegram_messages" USING btree ("installation_id","chat_id");--> statement-breakpoint
CREATE INDEX "idx_telegram_messages_created_at" ON "telegram_messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_thread_sessions_chat_user_link" ON "telegram_thread_sessions" USING btree ("telegram_user_link_id","chat_id","root_message_id");--> statement-breakpoint
CREATE INDEX "idx_telegram_thread_sessions_user_link" ON "telegram_thread_sessions" USING btree ("telegram_user_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_user_links_user_installation" ON "telegram_user_links" USING btree ("telegram_user_id","installation_id");