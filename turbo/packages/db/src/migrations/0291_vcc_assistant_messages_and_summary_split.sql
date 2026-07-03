ALTER TABLE "feature_candidate_voice_chat_tasks" ADD COLUMN "assistant_messages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" ADD COLUMN "conversation_summary" text;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" ADD COLUMN "working_tasks_summary" text;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" ADD COLUMN "finished_tasks_summary" text;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" ADD COLUMN "summary_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" ADD COLUMN "summary_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" ADD COLUMN "last_summary_at" timestamp;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN "context";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN "context_seq";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN "context_version";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN "last_reasoning_at";