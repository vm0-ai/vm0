DROP INDEX "idx_fc_voice_chat_sessions_status";--> statement-breakpoint
CREATE INDEX "idx_fc_voice_chat_sessions_user_agent_created" ON "feature_candidate_voice_chat_sessions" USING btree ("user_id","agent_id","created_at");--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN "last_heartbeat_at";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN "ended_at";