CREATE TABLE "imessage_thread_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"last_message_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imessage_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imessage_handle" varchar(50) NOT NULL,
	"org_id" text NOT NULL,
	"vm0_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imessage_thread_sessions" ADD CONSTRAINT "imessage_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_imessage_thread_sessions_user_org" ON "imessage_thread_sessions" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_imessage_user_links_handle" ON "imessage_user_links" USING btree ("imessage_handle");--> statement-breakpoint
CREATE INDEX "idx_imessage_user_links_org_user" ON "imessage_user_links" USING btree ("org_id","vm0_user_id");