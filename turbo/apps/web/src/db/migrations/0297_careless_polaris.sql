-- Drop the per-session lifecycle columns. The voice-chat-candidate model
-- is now stateless: a session is a persistent container keyed by
-- (userId, agentId), with createSession acting as get-or-create. There is
-- no more active/ended/timeout distinction, no heartbeat, no endedAt.
DROP INDEX IF EXISTS "idx_fc_voice_chat_sessions_status";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN IF EXISTS "last_heartbeat_at";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" DROP COLUMN IF EXISTS "ended_at";--> statement-breakpoint

-- New index supports the "latest session for (userId, agentId)" lookup
-- performed by createVoiceChatCandidateSession.
CREATE INDEX "idx_fc_voice_chat_sessions_user_agent_created" ON "feature_candidate_voice_chat_sessions" USING btree ("user_id","agent_id","created_at");
