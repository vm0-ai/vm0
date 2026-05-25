CREATE TABLE "voice_chat_realtime_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voice_chat_session_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(50) NOT NULL,
	"model" varchar(100) NOT NULL,
	"transcription_model" varchar(100),
	"openai_session_id" text,
	"openai_call_id" text,
	"status" varchar(20) DEFAULT 'starting' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"last_usage_at" timestamp,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_chat_realtime_sessions" ADD CONSTRAINT "voice_chat_realtime_sessions_voice_chat_session_id_voice_chat_sessions_id_fk" FOREIGN KEY ("voice_chat_session_id") REFERENCES "public"."voice_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vcrs_voice_chat_session" ON "voice_chat_realtime_sessions" USING btree ("voice_chat_session_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_vcrs_org_started" ON "voice_chat_realtime_sessions" USING btree ("org_id","started_at" DESC NULLS LAST);