ALTER TYPE "public"."chat_thread_event_kind" ADD VALUE 'image_model_updated' BEFORE 'sort_touched';--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_metadata_presence_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "selected_image_model" varchar(255);--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN "selected_image_model" varchar(255);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "selected_image_model" varchar(255);--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD COLUMN "selected_image_model" varchar(255);--> statement-breakpoint
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