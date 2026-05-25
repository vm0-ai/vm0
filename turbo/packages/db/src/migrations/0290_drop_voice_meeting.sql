DROP TABLE "voice_chat_preparations" CASCADE;--> statement-breakpoint
ALTER TABLE "voice_chat_sessions" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "voice_chat_sessions" DROP COLUMN "prompt";