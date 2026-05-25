ALTER TABLE "feature_candidate_voice_chat_items" RENAME TO "voice_chat_items";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" RENAME TO "voice_chat_sessions";--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_tasks" RENAME TO "voice_chat_tasks";--> statement-breakpoint
ALTER TABLE "voice_chat_items" DROP CONSTRAINT "feature_candidate_voice_chat_items_session_id_feature_candidate_voice_chat_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "voice_chat_sessions" DROP CONSTRAINT "feature_candidate_voice_chat_sessions_agent_id_agent_composes_id_fk";
--> statement-breakpoint
ALTER TABLE "voice_chat_tasks" DROP CONSTRAINT "feature_candidate_voice_chat_tasks_session_id_feature_candidate_voice_chat_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "voice_chat_tasks" DROP CONSTRAINT "feature_candidate_voice_chat_tasks_run_id_agent_runs_id_fk";
--> statement-breakpoint
DROP INDEX "idx_fc_voice_chat_items_session_seq";--> statement-breakpoint
DROP INDEX "uq_fc_voice_chat_items_session_realtime";--> statement-breakpoint
DROP INDEX "idx_fc_voice_chat_sessions_user";--> statement-breakpoint
DROP INDEX "idx_fc_voice_chat_sessions_user_agent_created";--> statement-breakpoint
DROP INDEX "idx_fc_voice_chat_tasks_session_status_created";--> statement-breakpoint
ALTER TABLE "voice_chat_items" ADD CONSTRAINT "voice_chat_items_session_id_voice_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."voice_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_chat_sessions" ADD CONSTRAINT "voice_chat_sessions_agent_id_agent_composes_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_composes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_chat_tasks" ADD CONSTRAINT "voice_chat_tasks_session_id_voice_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."voice_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_chat_tasks" ADD CONSTRAINT "voice_chat_tasks_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_voice_chat_items_session_seq" ON "voice_chat_items" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_voice_chat_items_session_realtime" ON "voice_chat_items" USING btree ("session_id","realtime_item_id");--> statement-breakpoint
CREATE INDEX "idx_voice_chat_sessions_user" ON "voice_chat_sessions" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_voice_chat_sessions_user_agent_created" ON "voice_chat_sessions" USING btree ("user_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_voice_chat_tasks_session_status_created" ON "voice_chat_tasks" USING btree ("session_id","status","created_at");--> statement-breakpoint
ALTER TABLE "voice_chat_sessions" RENAME CONSTRAINT "feature_candidate_voice_chat_sessions_pkey" TO "voice_chat_sessions_pkey";--> statement-breakpoint
ALTER TABLE "voice_chat_items" RENAME CONSTRAINT "feature_candidate_voice_chat_items_pkey" TO "voice_chat_items_pkey";--> statement-breakpoint
ALTER TABLE "voice_chat_tasks" RENAME CONSTRAINT "feature_candidate_voice_chat_tasks_pkey" TO "voice_chat_tasks_pkey";--> statement-breakpoint
ALTER SEQUENCE "feature_candidate_voice_chat_items_seq_seq" RENAME TO "voice_chat_items_seq_seq";