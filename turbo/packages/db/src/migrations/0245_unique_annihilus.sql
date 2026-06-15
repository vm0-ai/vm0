ALTER TABLE "voice_chat_sessions" ADD COLUMN "mode" varchar(20) DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_chat_sessions" ADD COLUMN "prompt" text;