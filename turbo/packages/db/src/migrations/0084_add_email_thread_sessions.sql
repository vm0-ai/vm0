CREATE TABLE "email_thread_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"compose_id" uuid NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"last_email_message_id" varchar(512),
	"reply_to_token" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_thread_sessions" ADD CONSTRAINT "email_thread_sessions_compose_id_agent_composes_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_thread_sessions" ADD CONSTRAINT "email_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_email_thread_sessions_reply_token" ON "email_thread_sessions" USING btree ("reply_to_token");
--> statement-breakpoint
CREATE INDEX "idx_email_thread_sessions_user" ON "email_thread_sessions" USING btree ("user_id");
