-- vm0:non-transactional
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conrelid" = 'public.agent_runs'::regclass
      AND "conname" = 'agent_runs_metadata_presence_check'
  ) THEN
    ALTER TABLE "agent_runs"
    ADD CONSTRAINT "agent_runs_metadata_presence_check"
    CHECK (
      (
        "trigger_source" IS NULL AND
        "autonomy_budget" IS NULL AND
        "workflow_automation_id" IS NULL AND
        "goal_id" IS NULL AND
        "model_provider" IS NULL AND
        "model_provider_id" IS NULL AND
        "model_provider_credential_scope" IS NULL AND
        "selected_model" IS NULL AND
        "codex_service_tier" IS NULL AND
        "selected_video_model" IS NULL AND
        "chat_thread_id" IS NULL AND
        "api_started_at" IS NULL AND
        "first_assistant_event_acknowledged_at" IS NULL AND
        "summary" IS NULL AND
        "trigger_brief" IS NULL
      ) OR (
        "trigger_source" IS NOT NULL AND
        "autonomy_budget" IS NOT NULL
      )
    ) NOT VALID;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conrelid" = 'public.agent_runs'::regclass
      AND "conname" = 'agent_runs_metadata_presence_check'
      AND "contype" = 'c'
  ) THEN
    RAISE EXCEPTION
      'Stage 4 found an unexpected agent_runs_metadata_presence_check object';
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
ALTER TABLE "agent_runs"
VALIDATE CONSTRAINT "agent_runs_metadata_presence_check";
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
DO $$
DECLARE
  "bridge_function_count" integer;
  "bridge_trigger_count" integer;
  "metadata_mismatch_count" bigint;
BEGIN
  SELECT count(*)::integer
  INTO "bridge_trigger_count"
  FROM "pg_trigger" AS "trigger_row"
  INNER JOIN "pg_class" AS "table_row"
    ON "table_row"."oid" = "trigger_row"."tgrelid"
  INNER JOIN "pg_namespace" AS "table_namespace"
    ON "table_namespace"."oid" = "table_row"."relnamespace"
  INNER JOIN "pg_proc" AS "function_row"
    ON "function_row"."oid" = "trigger_row"."tgfoid"
  INNER JOIN "pg_namespace" AS "function_namespace"
    ON "function_namespace"."oid" = "function_row"."pronamespace"
  WHERE "table_namespace"."nspname" = 'public'
    AND "table_row"."relname" = 'zero_runs'
    AND "trigger_row"."tgname" = 'sync_zero_run_metadata_to_agent_runs'
    AND NOT "trigger_row"."tgisinternal"
    AND "trigger_row"."tgenabled" = 'O'
    AND "function_namespace"."nspname" = 'public'
    AND "function_row"."proname" = 'sync_zero_run_metadata_to_agent_runs'
    AND pg_get_function_identity_arguments("function_row"."oid") = '';

  SELECT count(*)::integer
  INTO "bridge_function_count"
  FROM "pg_proc" AS "function_row"
  INNER JOIN "pg_namespace" AS "function_namespace"
    ON "function_namespace"."oid" = "function_row"."pronamespace"
  WHERE "function_namespace"."nspname" = 'public'
    AND "function_row"."proname" = 'sync_zero_run_metadata_to_agent_runs'
    AND pg_get_function_identity_arguments("function_row"."oid") = '';

  IF "bridge_trigger_count" NOT IN (0, 1)
    OR "bridge_function_count" NOT IN (0, 1)
    OR "bridge_trigger_count" <> "bridge_function_count"
  THEN
    RAISE EXCEPTION
      'Stage 4 expected matching bridge trigger/function state; found triggers=%, functions=%',
      "bridge_trigger_count",
      "bridge_function_count";
  END IF;

  SELECT count(*)
  INTO "metadata_mismatch_count"
  FROM "zero_runs" AS "source"
  LEFT JOIN "agent_runs" AS "target" ON "target"."id" = "source"."id"
  WHERE "target"."id" IS NULL
    OR ROW(
      "target"."trigger_source",
      "target"."autonomy_budget",
      "target"."workflow_automation_id",
      "target"."goal_id",
      "target"."model_provider",
      "target"."model_provider_id",
      "target"."model_provider_credential_scope",
      "target"."selected_model",
      "target"."codex_service_tier",
      "target"."selected_video_model",
      "target"."chat_thread_id",
      "target"."api_started_at",
      "target"."first_assistant_event_acknowledged_at",
      "target"."summary",
      "target"."trigger_brief"
    ) IS DISTINCT FROM ROW(
      "source"."trigger_source",
      "source"."autonomy_budget",
      "source"."workflow_automation_id",
      "source"."goal_id",
      "source"."model_provider",
      "source"."model_provider_id",
      "source"."model_provider_credential_scope",
      "source"."selected_model",
      "source"."codex_service_tier",
      "source"."selected_video_model",
      "source"."chat_thread_id",
      "source"."api_started_at",
      "source"."first_assistant_event_acknowledged_at",
      "source"."summary",
      "source"."trigger_brief"
    );

  IF "metadata_mismatch_count" <> 0 THEN
    RAISE EXCEPTION
      'Stage 4 compatibility verification found % zero_runs/agent_runs metadata mismatches',
      "metadata_mismatch_count";
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "canonicalize_hosted_site_scope_0753"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."chat_thread_id" IS NOT NULL
      AND NEW."chat_thread_id" IS DISTINCT FROM OLD."chat_thread_id"
    THEN
      RAISE EXCEPTION 'Hosted site chat ownership is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."requested_slug" IS NULL THEN
    NEW."requested_slug" := NEW."slug";
  END IF;

  IF NEW."chat_thread_id" IS NULL AND NEW."created_from_run_id" IS NOT NULL THEN
    SELECT "run"."chat_thread_id"
    INTO NEW."chat_thread_id"
    FROM "agent_runs" AS "run"
    WHERE "run"."id"::text = NEW."created_from_run_id"
      AND "run"."trigger_source" IS NOT NULL;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_hosted_deployment_scope_0753"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  "site_chat_thread_id" uuid;
  "run_chat_thread_id" uuid;
BEGIN
  SELECT "site"."chat_thread_id"
  INTO "site_chat_thread_id"
  FROM "hosted_sites" AS "site"
  WHERE "site"."id" = NEW."site_id";

  IF NEW."run_id" IS NOT NULL THEN
    SELECT "run"."chat_thread_id"
    INTO "run_chat_thread_id"
    FROM "agent_runs" AS "run"
    WHERE "run"."id"::text = NEW."run_id"
      AND "run"."trigger_source" IS NOT NULL;
  END IF;

  IF "site_chat_thread_id" IS DISTINCT FROM "run_chat_thread_id" THEN
    RAISE EXCEPTION
      'Hosted site belongs to a different chat; choose another site slug'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "queue_artifact_catalog_file"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  catalog_author_user_id text;
BEGIN
  IF NEW."url" IS NULL OR NEW."org_id" IS NULL THEN
    DELETE FROM "artifact_catalog_pending_files"
    WHERE "file_id" = NEW."id";
    RETURN NEW;
  END IF;

  catalog_author_user_id := COALESCE(
    (
      SELECT thread."user_id"
      FROM "chat_threads" AS thread
      WHERE thread."id" = COALESCE(
        NEW."chat_thread_id",
        (
          SELECT run."chat_thread_id"
          FROM "agent_runs" AS run
          WHERE run."id" = NEW."run_id"
            AND run."trigger_source" IS NOT NULL
        ),
        (
          SELECT message."chat_thread_id"
          FROM "chat_events" AS message
          WHERE message."run_id" = NEW."run_id"
          ORDER BY message."seq_id" ASC
          LIMIT 1
        )
      )
    ),
    NEW."user_id"
  );

  INSERT INTO "artifact_catalog_pending_files" (
    "file_id",
    "org_id",
    "author_user_id",
    "queued_at"
  )
  VALUES (
    NEW."id",
    NEW."org_id",
    catalog_author_user_id,
    clock_timestamp()
  )
  ON CONFLICT ("file_id") DO UPDATE SET
    "org_id" = EXCLUDED."org_id",
    "author_user_id" = EXCLUDED."author_user_id",
    "queued_at" = EXCLUDED."queued_at";

  RETURN NEW;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sync_zero_run_metadata_to_agent_runs" ON "zero_runs";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "sync_zero_run_metadata_to_agent_runs"();
--> statement-breakpoint
COMMIT;
