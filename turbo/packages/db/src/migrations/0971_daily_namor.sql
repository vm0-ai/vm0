ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_metadata_presence_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "built_in_model_key_id" uuid;--> statement-breakpoint
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
            "agent_runs"."built_in_model_key_id" IS NULL AND
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
        ));--> statement-breakpoint

-- Temporary #28679 DB/API rollout bridge; observed maximum version skew is
-- ~102 minutes. Remove in #28368 only after the canonical reader/writer switch,
-- legacy-column contract, and rollback drain have all completed.
CREATE FUNCTION "sync_agent_run_model_key_ids_0971"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  legacy_changed boolean;
  canonical_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."vm0_model_key_id" IS NOT NULL
      AND NEW."built_in_model_key_id" IS NOT NULL
      AND NEW."vm0_model_key_id" IS DISTINCT FROM NEW."built_in_model_key_id"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'agent run model key IDs must match',
        CONSTRAINT = 'agent_runs_model_key_id_mirror_check';
    ELSIF NEW."vm0_model_key_id" IS NULL THEN
      NEW."vm0_model_key_id" := NEW."built_in_model_key_id";
    ELSIF NEW."built_in_model_key_id" IS NULL THEN
      NEW."built_in_model_key_id" := NEW."vm0_model_key_id";
    END IF;

    RETURN NEW;
  END IF;

  legacy_changed :=
    NEW."vm0_model_key_id" IS DISTINCT FROM OLD."vm0_model_key_id";
  canonical_changed :=
    NEW."built_in_model_key_id" IS DISTINCT FROM OLD."built_in_model_key_id";

  IF legacy_changed AND NOT canonical_changed THEN
    NEW."built_in_model_key_id" := NEW."vm0_model_key_id";
  ELSIF canonical_changed AND NOT legacy_changed THEN
    NEW."vm0_model_key_id" := NEW."built_in_model_key_id";
  ELSIF legacy_changed AND canonical_changed THEN
    IF NEW."vm0_model_key_id" IS NOT NULL
      AND NEW."built_in_model_key_id" IS NOT NULL
      AND NEW."vm0_model_key_id" IS DISTINCT FROM NEW."built_in_model_key_id"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'agent run model key IDs must match',
        CONSTRAINT = 'agent_runs_model_key_id_mirror_check';
    ELSIF NEW."vm0_model_key_id" IS NULL THEN
      NEW."vm0_model_key_id" := NEW."built_in_model_key_id";
    ELSIF NEW."built_in_model_key_id" IS NULL THEN
      NEW."built_in_model_key_id" := NEW."vm0_model_key_id";
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "sync_agent_run_model_key_ids_0971"
BEFORE INSERT OR UPDATE OF "vm0_model_key_id", "built_in_model_key_id"
ON "agent_runs"
FOR EACH ROW
EXECUTE FUNCTION "sync_agent_run_model_key_ids_0971"();
