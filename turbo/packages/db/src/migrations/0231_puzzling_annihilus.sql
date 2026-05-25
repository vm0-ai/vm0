CREATE TABLE "voice_chat_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" serial NOT NULL,
	"source" varchar(20) NOT NULL,
	"type" varchar(30) NOT NULL,
	"content" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "voice_chat_events" ADD CONSTRAINT "voice_chat_events_session_id_voice_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."voice_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_chat_sessions" ADD CONSTRAINT "voice_chat_sessions_agent_id_agent_composes_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_composes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_chat_sessions" ADD CONSTRAINT "voice_chat_sessions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_voice_chat_events_session_seq" ON "voice_chat_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "idx_voice_chat_sessions_user" ON "voice_chat_sessions" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_voice_chat_sessions_status" ON "voice_chat_sessions" USING btree ("status");