ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_metadata_presence_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_runtime_provider" varchar(100);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_runtime_model" varchar(255);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "vm0_model_key_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_metadata_presence_check" CHECK ((
          (
            "agent_runs"."trigger_source" IS NULL AND
            "agent_runs"."autonomy_budget" IS NULL AND
            "agent_runs"."workflow_automation_id" IS NULL AND
            "agent_runs"."goal_id" IS NULL AND
            "agent_runs"."model_provider" IS NULL AND
            "agent_runs"."model_provider_id" IS NULL AND
            "agent_runs"."model_provider_credential_scope" IS NULL AND
            "agent_runs"."selected_model" IS NULL AND
            "agent_runs"."model_runtime_provider" IS NULL AND
            "agent_runs"."model_runtime_model" IS NULL AND
            "agent_runs"."vm0_model_key_id" IS NULL AND
            "agent_runs"."codex_service_tier" IS NULL AND
            "agent_runs"."selected_video_model" IS NULL AND
            "agent_runs"."selected_image_model" IS NULL AND
            "agent_runs"."chat_thread_id" IS NULL AND
            "agent_runs"."api_started_at" IS NULL AND
            "agent_runs"."first_assistant_event_acknowledged_at" IS NULL AND
            "agent_runs"."summary" IS NULL AND
            "agent_runs"."trigger_brief" IS NULL
          ) OR (
            "agent_runs"."trigger_source" IS NOT NULL AND
            "agent_runs"."autonomy_budget" IS NOT NULL
          )
        ));