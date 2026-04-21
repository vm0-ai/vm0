ALTER TABLE "feature_candidate_voice_chat_tasks" DROP COLUMN "result";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_tasks" ADD COLUMN "result" jsonb DEFAULT '[]'::jsonb NOT NULL;