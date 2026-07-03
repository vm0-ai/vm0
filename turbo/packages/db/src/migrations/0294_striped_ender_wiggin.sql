CREATE TABLE "voice_chat_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid,
	"prompt" text NOT NULL,
	"status" varchar(20) NOT NULL,
	"result" text,
	"error" text,
	"assistant_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "voice_chat_tasks" ADD CONSTRAINT "voice_chat_tasks_session_id_voice_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."voice_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_chat_tasks" ADD CONSTRAINT "voice_chat_tasks_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_voice_chat_tasks_session_status_created" ON "voice_chat_tasks" USING btree ("session_id","status","created_at");