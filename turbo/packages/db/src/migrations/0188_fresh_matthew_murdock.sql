ALTER TABLE "slack_org_pending_questions" DROP CONSTRAINT "slack_org_pending_questions_compose_id_agent_composes_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_org_pending_questions" DROP CONSTRAINT "slack_org_pending_questions_session_id_agent_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_org_thread_sessions" DROP CONSTRAINT "slack_org_thread_sessions_agent_session_id_agent_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_org_pending_questions" ADD CONSTRAINT "slack_org_pending_questions_compose_id_agent_composes_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_org_pending_questions" ADD CONSTRAINT "slack_org_pending_questions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_org_thread_sessions" ADD CONSTRAINT "slack_org_thread_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;