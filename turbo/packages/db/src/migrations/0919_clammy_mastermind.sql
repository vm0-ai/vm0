ALTER TABLE "agent_runs" ADD COLUMN "trigger_source" varchar(20);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "autonomy_budget" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "workflow_automation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_provider" varchar(100);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_provider_credential_scope" varchar(20);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "selected_model" varchar(255);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "codex_service_tier" varchar(20);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "selected_video_model" varchar(255);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "chat_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "api_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "first_assistant_event_acknowledged_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "trigger_brief" text;--> statement-breakpoint
CREATE FUNCTION "sync_zero_run_metadata_to_agent_runs"() RETURNS trigger AS $$
BEGIN
	UPDATE "agent_runs" AS "agent_run"
	SET
		"trigger_source" = NEW."trigger_source",
		"autonomy_budget" = NEW."autonomy_budget",
		"workflow_automation_id" = NEW."workflow_automation_id",
		"goal_id" = NEW."goal_id",
		"model_provider" = NEW."model_provider",
		"model_provider_id" = NEW."model_provider_id",
		"model_provider_credential_scope" = NEW."model_provider_credential_scope",
		"selected_model" = NEW."selected_model",
		"codex_service_tier" = NEW."codex_service_tier",
		"selected_video_model" = NEW."selected_video_model",
		"chat_thread_id" = NEW."chat_thread_id",
		"api_started_at" = NEW."api_started_at",
		"first_assistant_event_acknowledged_at" = NEW."first_assistant_event_acknowledged_at",
		"summary" = NEW."summary",
		"trigger_brief" = NEW."trigger_brief"
	WHERE "agent_run"."id" = NEW."id"
		AND ROW(
			"agent_run"."trigger_source",
			"agent_run"."autonomy_budget",
			"agent_run"."workflow_automation_id",
			"agent_run"."goal_id",
			"agent_run"."model_provider",
			"agent_run"."model_provider_id",
			"agent_run"."model_provider_credential_scope",
			"agent_run"."selected_model",
			"agent_run"."codex_service_tier",
			"agent_run"."selected_video_model",
			"agent_run"."chat_thread_id",
			"agent_run"."api_started_at",
			"agent_run"."first_assistant_event_acknowledged_at",
			"agent_run"."summary",
			"agent_run"."trigger_brief"
		) IS DISTINCT FROM ROW(
			NEW."trigger_source",
			NEW."autonomy_budget",
			NEW."workflow_automation_id",
			NEW."goal_id",
			NEW."model_provider",
			NEW."model_provider_id",
			NEW."model_provider_credential_scope",
			NEW."selected_model",
			NEW."codex_service_tier",
			NEW."selected_video_model",
			NEW."chat_thread_id",
			NEW."api_started_at",
			NEW."first_assistant_event_acknowledged_at",
			NEW."summary",
			NEW."trigger_brief"
		);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sync_zero_run_metadata_to_agent_runs"
AFTER INSERT OR UPDATE OF
	"trigger_source",
	"autonomy_budget",
	"workflow_automation_id",
	"goal_id",
	"model_provider",
	"model_provider_id",
	"model_provider_credential_scope",
	"selected_model",
	"codex_service_tier",
	"selected_video_model",
	"chat_thread_id",
	"api_started_at",
	"first_assistant_event_acknowledged_at",
	"summary",
	"trigger_brief"
ON "zero_runs"
FOR EACH ROW EXECUTE FUNCTION "sync_zero_run_metadata_to_agent_runs"();
