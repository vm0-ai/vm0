CREATE TABLE "email_reply_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"email_thread_session_id" uuid NOT NULL,
	"inbound_email_id" varchar(255) NOT NULL,
	"inbound_message_id" varchar(512),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_reply_requests" ADD CONSTRAINT "email_reply_requests_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_reply_requests" ADD CONSTRAINT "email_reply_requests_email_thread_session_id_email_thread_sessions_id_fk" FOREIGN KEY ("email_thread_session_id") REFERENCES "public"."email_thread_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_email_reply_requests_run" ON "email_reply_requests" USING btree ("run_id");
