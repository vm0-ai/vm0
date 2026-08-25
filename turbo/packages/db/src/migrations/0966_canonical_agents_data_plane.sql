-- vm0:non-transactional
-- #28601 / #26938 additive canonical Agent data plane. Legacy relations and columns
-- remain the only application read/write authority in this boundary.

-- Fail closed on source identity drift, then create the empty target and
-- install the legacy-source-to-target bridge before moving any data.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
  v_server_version_num integer;
  v_zero_only_count bigint;
  v_identity_mismatch_count bigint;
  v_unmatched_exposed_reference_count bigint;
BEGIN
  SELECT current_setting('server_version_num')::integer
  INTO v_server_version_num;

  IF v_server_version_num < 170000 THEN
    RAISE EXCEPTION 'Canonical Agent data plane requires PostgreSQL server_version_num >= 170000, found %',
      v_server_version_num;
  END IF;

  SELECT count(*)
  INTO v_zero_only_count
  FROM "zero_agents" AS "zero_agent"
  LEFT JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "zero_agent"."id"
  WHERE "compose"."id" IS NULL;

  SELECT count(*)
  INTO v_identity_mismatch_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  WHERE "compose"."org_id" IS DISTINCT FROM "zero_agent"."org_id"
    OR "compose"."user_id" IS DISTINCT FROM "zero_agent"."owner"
    OR "compose"."name" IS DISTINCT FROM "zero_agent"."name";

  SELECT count(*)
  INTO v_unmatched_exposed_reference_count
  FROM (
    SELECT "default_compose_id" AS "legacy_id"
    FROM "telegram_installations"
    UNION ALL
    SELECT "default_compose_id" FROM "feishu_org_installations"
    UNION ALL
    SELECT "default_compose_id" FROM "github_installations"
    UNION ALL
    SELECT "selected_compose_id" FROM "slack_user_agent_preferences"
    UNION ALL
    SELECT "selected_compose_id" FROM "teams_user_agent_preferences"
    UNION ALL
    SELECT "selected_compose_id" FROM "agentphone_user_agent_preferences"
    UNION ALL
    SELECT "selected_compose_id" FROM "telegram_user_agent_preferences"
    UNION ALL
    SELECT "selected_compose_id" FROM "feishu_user_agent_preferences"
    UNION ALL
    SELECT "default_agent_id" FROM "org_metadata"
  ) AS "reference"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "reference"."legacy_id"
  WHERE "reference"."legacy_id" IS NOT NULL
    AND "zero_agent"."id" IS NULL;

  IF v_zero_only_count <> 0 THEN
    RAISE EXCEPTION 'Canonical Agent preflight found % zero_agents-only identities',
      v_zero_only_count;
  END IF;

  IF v_identity_mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Canonical Agent preflight found % cross-source identity mismatches',
      v_identity_mismatch_count;
  END IF;

  IF v_unmatched_exposed_reference_count <> 0 THEN
    RAISE EXCEPTION 'Canonical Agent preflight found % exposed references to unmatched identities',
      v_unmatched_exposed_reference_count;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "owner" text NOT NULL,
  "name" varchar(64) NOT NULL,
  "visibility" varchar(16) DEFAULT 'public' NOT NULL,
  "display_name" varchar(256),
  "description" text,
  "sound" varchar(64),
  "avatar_url" varchar(1024),
  "model_provider_id" uuid,
  "selected_model" varchar(255),
  "prefer_personal_provider" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "agents_model_provider_id_model_providers_id_fk"
    FOREIGN KEY ("model_provider_id")
    REFERENCES "public"."model_providers"("id")
    ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_agents_org_name"
ON "agents" USING btree ("org_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agents_org"
ON "agents" USING btree ("org_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sync_agent_from_legacy_0966"(
  p_agent_id uuid
) RETURNS void AS $$
BEGIN
  -- Delete only when a legacy identity row disappears. Retaining the last
  -- complete target through an in-transaction two-row update avoids a
  -- transient mismatch cascading dependent-row deletion.
  DELETE FROM "agents" AS "agent"
  WHERE "agent"."id" = p_agent_id
    AND (
      NOT EXISTS (
        SELECT 1 FROM "agent_composes" AS "compose"
        WHERE "compose"."id" = p_agent_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM "zero_agents" AS "zero_agent"
        WHERE "zero_agent"."id" = p_agent_id
      )
    );

  INSERT INTO "agents" (
    "id", "org_id", "owner", "name", "visibility", "display_name",
    "description", "sound", "avatar_url", "model_provider_id",
    "selected_model", "prefer_personal_provider", "created_at", "updated_at"
  )
  SELECT
    "compose"."id",
    "zero_agent"."org_id",
    "zero_agent"."owner",
    "zero_agent"."name",
    "zero_agent"."visibility",
    "zero_agent"."display_name",
    "zero_agent"."description",
    "zero_agent"."sound",
    "zero_agent"."avatar_url",
    "zero_agent"."model_provider_id",
    "zero_agent"."selected_model",
    "zero_agent"."prefer_personal_provider",
    "compose"."created_at",
    greatest("compose"."updated_at", "zero_agent"."updated_at")
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  WHERE "compose"."id" = p_agent_id
    AND "compose"."org_id" IS NOT DISTINCT FROM "zero_agent"."org_id"
    AND "compose"."user_id" IS NOT DISTINCT FROM "zero_agent"."owner"
    AND "compose"."name" IS NOT DISTINCT FROM "zero_agent"."name"
  ON CONFLICT ("id") DO UPDATE SET
    "org_id" = excluded."org_id",
    "owner" = excluded."owner",
    "name" = excluded."name",
    "visibility" = excluded."visibility",
    "display_name" = excluded."display_name",
    "description" = excluded."description",
    "sound" = excluded."sound",
    "avatar_url" = excluded."avatar_url",
    "model_provider_id" = excluded."model_provider_id",
    "selected_model" = excluded."selected_model",
    "prefer_personal_provider" = excluded."prefer_personal_provider",
    "created_at" = excluded."created_at",
    "updated_at" = excluded."updated_at";
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bridge_legacy_agent_to_agents_0966"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "sync_agent_from_legacy_0966"(OLD."id");
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
    PERFORM "sync_agent_from_legacy_0966"(OLD."id");
  END IF;

  PERFORM "sync_agent_from_legacy_0966"(NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_agent_composes_to_agents_0966"
ON "agent_composes";
--> statement-breakpoint
CREATE TRIGGER "bridge_agent_composes_to_agents_0966"
AFTER INSERT OR DELETE OR UPDATE OF
  "id", "user_id", "name", "org_id", "created_at", "updated_at"
ON "agent_composes"
FOR EACH ROW EXECUTE FUNCTION "bridge_legacy_agent_to_agents_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_zero_agents_to_agents_0966"
ON "zero_agents";
--> statement-breakpoint
CREATE TRIGGER "bridge_zero_agents_to_agents_0966"
AFTER INSERT OR DELETE OR UPDATE OF
  "id", "org_id", "owner", "name", "visibility", "display_name",
  "description", "sound", "avatar_url", "model_provider_id",
  "selected_model", "prefer_personal_provider", "created_at", "updated_at"
ON "zero_agents"
FOR EACH ROW EXECUTE FUNCTION "bridge_legacy_agent_to_agents_0966"();
--> statement-breakpoint
DO $$
DECLARE
  v_column_count integer;
  v_target_trigger_count integer;
BEGIN
  SELECT count(*)
  INTO v_column_count
  FROM "information_schema"."columns"
  WHERE "table_schema" = 'public'
    AND "table_name" = 'agents'
    AND ("column_name", "data_type", "is_nullable") IN (
      ('id', 'uuid', 'NO'),
      ('org_id', 'text', 'NO'),
      ('owner', 'text', 'NO'),
      ('name', 'character varying', 'NO'),
      ('visibility', 'character varying', 'NO'),
      ('display_name', 'character varying', 'YES'),
      ('description', 'text', 'YES'),
      ('sound', 'character varying', 'YES'),
      ('avatar_url', 'character varying', 'YES'),
      ('model_provider_id', 'uuid', 'YES'),
      ('selected_model', 'character varying', 'YES'),
      ('prefer_personal_provider', 'boolean', 'NO'),
      ('created_at', 'timestamp without time zone', 'NO'),
      ('updated_at', 'timestamp without time zone', 'NO')
    );

  IF v_column_count <> 14 OR (
    SELECT count(*)
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public' AND "table_name" = 'agents'
  ) <> 14 THEN
    RAISE EXCEPTION 'Canonical agents table column contract drifted';
  END IF;

  SELECT count(*)
  INTO v_target_trigger_count
  FROM "pg_trigger" AS "trigger"
  WHERE "trigger"."tgrelid" = 'public.agents'::regclass
    AND NOT "trigger"."tgisinternal";

  IF v_target_trigger_count <> 0 THEN
    RAISE EXCEPTION 'Canonical agents table has % forbidden target-to-legacy triggers',
      v_target_trigger_count;
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Add every legacy-named sibling with one-second catalog lock acquisition.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_event_search_messages" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "telegram_installations" ADD COLUMN IF NOT EXISTS "default_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD COLUMN IF NOT EXISTS "default_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN IF NOT EXISTS "default_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences" ADD COLUMN IF NOT EXISTS "selected_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences" ADD COLUMN IF NOT EXISTS "selected_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "agentphone_user_agent_preferences" ADD COLUMN IF NOT EXISTS "selected_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences" ADD COLUMN IF NOT EXISTS "selected_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences" ADD COLUMN IF NOT EXISTS "selected_agent_id" uuid;
--> statement-breakpoint

BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bridge_agent_compose_reference_0966"()
RETURNS trigger AS $$
BEGIN
  SELECT "agent"."id"
  INTO NEW."agent_id"
  FROM "agents" AS "agent"
  WHERE "agent"."id" = NEW."agent_compose_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bridge_default_compose_reference_0966"()
RETURNS trigger AS $$
BEGIN
  SELECT "agent"."id"
  INTO NEW."default_agent_id"
  FROM "agents" AS "agent"
  WHERE "agent"."id" = NEW."default_compose_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bridge_selected_compose_reference_0966"()
RETURNS trigger AS $$
BEGIN
  SELECT "agent"."id"
  INTO NEW."selected_agent_id"
  FROM "agents" AS "agent"
  WHERE "agent"."id" = NEW."selected_compose_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_agent_sessions_agent_reference_0966" ON "agent_sessions";
--> statement-breakpoint
CREATE TRIGGER "bridge_agent_sessions_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "agent_compose_id" ON "agent_sessions"
FOR EACH ROW EXECUTE FUNCTION "bridge_agent_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_chat_threads_agent_reference_0966" ON "chat_threads";
--> statement-breakpoint
CREATE TRIGGER "bridge_chat_threads_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "agent_compose_id" ON "chat_threads"
FOR EACH ROW EXECUTE FUNCTION "bridge_agent_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_chat_thread_events_agent_reference_0966" ON "chat_thread_events";
--> statement-breakpoint
CREATE TRIGGER "bridge_chat_thread_events_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "agent_compose_id" ON "chat_thread_events"
FOR EACH ROW EXECUTE FUNCTION "bridge_agent_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_chat_event_search_agent_reference_0966" ON "chat_event_search_messages";
--> statement-breakpoint
CREATE TRIGGER "bridge_chat_event_search_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "agent_compose_id" ON "chat_event_search_messages"
FOR EACH ROW EXECUTE FUNCTION "bridge_agent_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_telegram_installations_agent_reference_0966" ON "telegram_installations";
--> statement-breakpoint
CREATE TRIGGER "bridge_telegram_installations_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "default_compose_id" ON "telegram_installations"
FOR EACH ROW EXECUTE FUNCTION "bridge_default_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_feishu_installations_agent_reference_0966" ON "feishu_org_installations";
--> statement-breakpoint
CREATE TRIGGER "bridge_feishu_installations_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "default_compose_id" ON "feishu_org_installations"
FOR EACH ROW EXECUTE FUNCTION "bridge_default_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_github_installations_agent_reference_0966" ON "github_installations";
--> statement-breakpoint
CREATE TRIGGER "bridge_github_installations_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "default_compose_id" ON "github_installations"
FOR EACH ROW EXECUTE FUNCTION "bridge_default_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_slack_preferences_agent_reference_0966" ON "slack_user_agent_preferences";
--> statement-breakpoint
CREATE TRIGGER "bridge_slack_preferences_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "selected_compose_id" ON "slack_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "bridge_selected_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_teams_preferences_agent_reference_0966" ON "teams_user_agent_preferences";
--> statement-breakpoint
CREATE TRIGGER "bridge_teams_preferences_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "selected_compose_id" ON "teams_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "bridge_selected_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_agentphone_preferences_agent_reference_0966" ON "agentphone_user_agent_preferences";
--> statement-breakpoint
CREATE TRIGGER "bridge_agentphone_preferences_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "selected_compose_id" ON "agentphone_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "bridge_selected_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_telegram_preferences_agent_reference_0966" ON "telegram_user_agent_preferences";
--> statement-breakpoint
CREATE TRIGGER "bridge_telegram_preferences_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "selected_compose_id" ON "telegram_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "bridge_selected_compose_reference_0966"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bridge_feishu_preferences_agent_reference_0966" ON "feishu_user_agent_preferences";
--> statement-breakpoint
CREATE TRIGGER "bridge_feishu_preferences_agent_reference_0966"
BEFORE INSERT OR UPDATE OF "selected_compose_id" ON "feishu_user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "bridge_selected_compose_reference_0966"();
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Backfill canonical Agents in restartable <=500-row transactions. Both
-- source rows are locked with SKIP LOCKED so a batch never publishes a mixed
-- source snapshot; the permanent bridge owns concurrent source writes.
CREATE OR REPLACE PROCEDURE "backfill_agents_0966"(
  p_no_progress_timeout interval
)
LANGUAGE plpgsql AS $$
DECLARE
  v_scan_after uuid := NULL;
  v_batch_ids uuid[];
  v_upserted_ids uuid[];
  v_batch_count integer;
  v_upserted_count integer;
  v_remaining boolean;
  v_no_progress_started_at timestamp with time zone := clock_timestamp();
BEGIN
  IF
    p_no_progress_timeout IS NULL
    OR p_no_progress_timeout <= interval '0 seconds'
    OR p_no_progress_timeout > interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Canonical Agent backfill no-progress timeout must be between 0 and 30 seconds';
  END IF;

  SET LOCAL lock_timeout = '1s';
  SET LOCAL transaction_timeout = '5min';

  LOOP
    WITH "batch" AS MATERIALIZED (
      SELECT
        "compose"."id",
        "zero_agent"."org_id",
        "zero_agent"."owner",
        "zero_agent"."name",
        "zero_agent"."visibility",
        "zero_agent"."display_name",
        "zero_agent"."description",
        "zero_agent"."sound",
        "zero_agent"."avatar_url",
        "zero_agent"."model_provider_id",
        "zero_agent"."selected_model",
        "zero_agent"."prefer_personal_provider",
        "compose"."created_at",
        greatest("compose"."updated_at", "zero_agent"."updated_at") AS "updated_at"
      FROM "agent_composes" AS "compose"
      INNER JOIN "zero_agents" AS "zero_agent"
        ON "zero_agent"."id" = "compose"."id"
      LEFT JOIN "agents" AS "agent"
        ON "agent"."id" = "compose"."id"
      WHERE (v_scan_after IS NULL OR "compose"."id" > v_scan_after)
        AND "compose"."org_id" IS NOT DISTINCT FROM "zero_agent"."org_id"
        AND "compose"."user_id" IS NOT DISTINCT FROM "zero_agent"."owner"
        AND "compose"."name" IS NOT DISTINCT FROM "zero_agent"."name"
        AND (
          "agent"."id" IS NULL
          OR ROW(
            "agent"."org_id", "agent"."owner", "agent"."name",
            "agent"."visibility", "agent"."display_name",
            "agent"."description", "agent"."sound", "agent"."avatar_url",
            "agent"."model_provider_id", "agent"."selected_model",
            "agent"."prefer_personal_provider", "agent"."created_at",
            "agent"."updated_at"
          ) IS DISTINCT FROM ROW(
            "zero_agent"."org_id", "zero_agent"."owner", "zero_agent"."name",
            "zero_agent"."visibility", "zero_agent"."display_name",
            "zero_agent"."description", "zero_agent"."sound",
            "zero_agent"."avatar_url", "zero_agent"."model_provider_id",
            "zero_agent"."selected_model",
            "zero_agent"."prefer_personal_provider", "compose"."created_at",
            greatest("compose"."updated_at", "zero_agent"."updated_at")
          )
        )
      ORDER BY "compose"."id"
      LIMIT 500
      FOR UPDATE OF "compose", "zero_agent" SKIP LOCKED
    ),
    "upserted" AS (
      INSERT INTO "agents" (
        "id", "org_id", "owner", "name", "visibility", "display_name",
        "description", "sound", "avatar_url", "model_provider_id",
        "selected_model", "prefer_personal_provider", "created_at", "updated_at"
      )
      SELECT
        "id", "org_id", "owner", "name", "visibility", "display_name",
        "description", "sound", "avatar_url", "model_provider_id",
        "selected_model", "prefer_personal_provider", "created_at", "updated_at"
      FROM "batch"
      ON CONFLICT ("id") DO UPDATE SET
        "org_id" = excluded."org_id",
        "owner" = excluded."owner",
        "name" = excluded."name",
        "visibility" = excluded."visibility",
        "display_name" = excluded."display_name",
        "description" = excluded."description",
        "sound" = excluded."sound",
        "avatar_url" = excluded."avatar_url",
        "model_provider_id" = excluded."model_provider_id",
        "selected_model" = excluded."selected_model",
        "prefer_personal_provider" = excluded."prefer_personal_provider",
        "created_at" = excluded."created_at",
        "updated_at" = excluded."updated_at"
      RETURNING "id"
    )
    SELECT
      coalesce(
        (SELECT array_agg("id" ORDER BY "id") FROM "batch"),
        ARRAY[]::uuid[]
      ),
      coalesce(
        (SELECT array_agg("id" ORDER BY "id") FROM "upserted"),
        ARRAY[]::uuid[]
      )
    INTO v_batch_ids, v_upserted_ids;

    v_batch_count := cardinality(v_batch_ids);
    v_upserted_count := cardinality(v_upserted_ids);

    IF v_upserted_count <> v_batch_count THEN
      RAISE EXCEPTION 'Canonical Agent backfill lost batch ownership';
    END IF;

    IF v_batch_count > 0 THEN
      v_scan_after := v_batch_ids[v_batch_count];
      v_no_progress_started_at := clock_timestamp();
    END IF;

    COMMIT;
    SET LOCAL lock_timeout = '1s';
    SET LOCAL transaction_timeout = '5min';

    IF v_batch_count > 0 THEN
      PERFORM pg_sleep(0.01);
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM "agent_composes" AS "compose"
      INNER JOIN "zero_agents" AS "zero_agent"
        ON "zero_agent"."id" = "compose"."id"
      LEFT JOIN "agents" AS "agent"
        ON "agent"."id" = "compose"."id"
      WHERE "compose"."org_id" IS NOT DISTINCT FROM "zero_agent"."org_id"
        AND "compose"."user_id" IS NOT DISTINCT FROM "zero_agent"."owner"
        AND "compose"."name" IS NOT DISTINCT FROM "zero_agent"."name"
        AND (
          "agent"."id" IS NULL
          OR ROW(
            "agent"."org_id", "agent"."owner", "agent"."name",
            "agent"."visibility", "agent"."display_name",
            "agent"."description", "agent"."sound", "agent"."avatar_url",
            "agent"."model_provider_id", "agent"."selected_model",
            "agent"."prefer_personal_provider", "agent"."created_at",
            "agent"."updated_at"
          ) IS DISTINCT FROM ROW(
            "zero_agent"."org_id", "zero_agent"."owner", "zero_agent"."name",
            "zero_agent"."visibility", "zero_agent"."display_name",
            "zero_agent"."description", "zero_agent"."sound",
            "zero_agent"."avatar_url", "zero_agent"."model_provider_id",
            "zero_agent"."selected_model",
            "zero_agent"."prefer_personal_provider", "compose"."created_at",
            greatest("compose"."updated_at", "zero_agent"."updated_at")
          )
        )
    ) INTO v_remaining;

    IF NOT v_remaining THEN
      EXIT;
    END IF;

    IF clock_timestamp() - v_no_progress_started_at >= p_no_progress_timeout THEN
      RAISE EXCEPTION 'Canonical Agent backfill made no progress for % while eligible rows remained',
        p_no_progress_timeout;
    END IF;

    v_scan_after := NULL;
    PERFORM pg_sleep(0.01);
  END LOOP;
END;
$$;
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
CALL "backfill_agents_0966"(interval '30 seconds');
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_agents_0966"(interval);
--> statement-breakpoint

BEGIN;
--> statement-breakpoint
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
DO $$
DECLARE
  v_matched_count bigint;
  v_target_count bigint;
  v_missing_target_count bigint;
  v_target_only_count bigint;
  v_compose_only_target_count bigint;
  v_field_mismatch_count bigint;
BEGIN
  SELECT count(*)
  INTO v_matched_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id";

  SELECT count(*) INTO v_target_count FROM "agents";

  SELECT count(*)
  INTO v_missing_target_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "compose"."id"
  WHERE "agent"."id" IS NULL;

  SELECT count(*)
  INTO v_target_only_count
  FROM "agents" AS "agent"
  LEFT JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "agent"."id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "agent"."id"
  WHERE "compose"."id" IS NULL OR "zero_agent"."id" IS NULL;

  SELECT count(*)
  INTO v_compose_only_target_count
  FROM "agent_composes" AS "compose"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  INNER JOIN "agents" AS "agent"
    ON "agent"."id" = "compose"."id"
  WHERE "zero_agent"."id" IS NULL;

  SELECT count(*)
  INTO v_field_mismatch_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  INNER JOIN "agents" AS "agent"
    ON "agent"."id" = "compose"."id"
  WHERE "compose"."org_id" IS DISTINCT FROM "zero_agent"."org_id"
    OR "compose"."user_id" IS DISTINCT FROM "zero_agent"."owner"
    OR "compose"."name" IS DISTINCT FROM "zero_agent"."name"
    OR ROW(
      "agent"."org_id", "agent"."owner", "agent"."name",
      "agent"."visibility", "agent"."display_name", "agent"."description",
      "agent"."sound", "agent"."avatar_url", "agent"."model_provider_id",
      "agent"."selected_model", "agent"."prefer_personal_provider",
      "agent"."created_at", "agent"."updated_at"
    ) IS DISTINCT FROM ROW(
      "zero_agent"."org_id", "zero_agent"."owner", "zero_agent"."name",
      "zero_agent"."visibility", "zero_agent"."display_name",
      "zero_agent"."description", "zero_agent"."sound",
      "zero_agent"."avatar_url", "zero_agent"."model_provider_id",
      "zero_agent"."selected_model", "zero_agent"."prefer_personal_provider",
      "compose"."created_at",
      greatest("compose"."updated_at", "zero_agent"."updated_at")
    );

  IF
    v_target_count <> v_matched_count
    OR v_missing_target_count <> 0
    OR v_target_only_count <> 0
    OR v_compose_only_target_count <> 0
    OR v_field_mismatch_count <> 0
  THEN
    RAISE EXCEPTION 'Canonical Agent parity failed: matched %, target %, missing %, target_only %, compose_only_target %, field_mismatch %',
      v_matched_count,
      v_target_count,
      v_missing_target_count,
      v_target_only_count,
      v_compose_only_target_count,
      v_field_mismatch_count;
  END IF;

  RAISE NOTICE 'Canonical Agent parity: matched=%, target=%, missing=%, target_only=%, compose_only_target=%, field_mismatch=%',
    v_matched_count,
    v_target_count,
    v_missing_target_count,
    v_target_only_count,
    v_compose_only_target_count,
    v_field_mismatch_count;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- One procedure owns the 11 small explicit reference cohorts. Each supplies
-- its immutable primary-key columns; the JSONB key is only a stable scan
-- cursor and is never persisted or emitted.
CREATE OR REPLACE PROCEDURE "backfill_agent_references_0966"(
  p_table regclass,
  p_key_columns name[],
  p_legacy_column name,
  p_target_column name,
  p_no_progress_timeout interval
)
LANGUAGE plpgsql AS $$
DECLARE
  v_scan_after text := NULL;
  v_scan_key_expression text;
  v_batch_count integer;
  v_updated_count integer;
  v_next_scan_after text;
  v_remaining boolean;
  v_no_progress_started_at timestamp with time zone := clock_timestamp();
BEGIN
  IF
    p_no_progress_timeout IS NULL
    OR p_no_progress_timeout <= interval '0 seconds'
    OR p_no_progress_timeout > interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Canonical Agent reference backfill no-progress timeout must be between 0 and 30 seconds';
  END IF;

  IF NOT (
    (p_table = 'public.agent_sessions'::regclass AND p_key_columns = ARRAY['id']::name[] AND p_legacy_column = 'agent_compose_id' AND p_target_column = 'agent_id')
    OR (p_table = 'public.chat_threads'::regclass AND p_key_columns = ARRAY['id']::name[] AND p_legacy_column = 'agent_compose_id' AND p_target_column = 'agent_id')
    OR (p_table = 'public.chat_thread_events'::regclass AND p_key_columns = ARRAY['id']::name[] AND p_legacy_column = 'agent_compose_id' AND p_target_column = 'agent_id')
    OR (p_table = 'public.telegram_installations'::regclass AND p_key_columns = ARRAY['telegram_bot_id']::name[] AND p_legacy_column = 'default_compose_id' AND p_target_column = 'default_agent_id')
    OR (p_table = 'public.feishu_org_installations'::regclass AND p_key_columns = ARRAY['id']::name[] AND p_legacy_column = 'default_compose_id' AND p_target_column = 'default_agent_id')
    OR (p_table = 'public.github_installations'::regclass AND p_key_columns = ARRAY['id']::name[] AND p_legacy_column = 'default_compose_id' AND p_target_column = 'default_agent_id')
    OR (p_table = 'public.slack_user_agent_preferences'::regclass AND p_key_columns = ARRAY['user_id', 'org_id']::name[] AND p_legacy_column = 'selected_compose_id' AND p_target_column = 'selected_agent_id')
    OR (p_table = 'public.teams_user_agent_preferences'::regclass AND p_key_columns = ARRAY['user_id', 'org_id']::name[] AND p_legacy_column = 'selected_compose_id' AND p_target_column = 'selected_agent_id')
    OR (p_table = 'public.agentphone_user_agent_preferences'::regclass AND p_key_columns = ARRAY['user_id', 'org_id']::name[] AND p_legacy_column = 'selected_compose_id' AND p_target_column = 'selected_agent_id')
    OR (p_table = 'public.telegram_user_agent_preferences'::regclass AND p_key_columns = ARRAY['user_id', 'org_id']::name[] AND p_legacy_column = 'selected_compose_id' AND p_target_column = 'selected_agent_id')
    OR (p_table = 'public.feishu_user_agent_preferences'::regclass AND p_key_columns = ARRAY['user_id', 'org_id']::name[] AND p_legacy_column = 'selected_compose_id' AND p_target_column = 'selected_agent_id')
  ) THEN
    RAISE EXCEPTION 'Unapproved canonical Agent reference backfill cohort';
  END IF;

  SELECT
    'jsonb_build_array(' ||
    string_agg(format('source.%I', "key_column"), ', ' ORDER BY "ordinality") ||
    ')::text'
  INTO v_scan_key_expression
  FROM unnest(p_key_columns) WITH ORDINALITY
    AS "key"("key_column", "ordinality");

  SET LOCAL lock_timeout = '1s';
  SET LOCAL transaction_timeout = '5min';

  LOOP
    EXECUTE format(
      $query$
      WITH "batch" AS MATERIALIZED (
        SELECT
          "source"."ctid" AS "row_ctid",
          %1$s AS "scan_key"
        FROM %2$s AS "source"
        WHERE ($1 IS NULL OR %1$s > $1)
          AND "source".%3$I IS DISTINCT FROM (
            SELECT "agent"."id"
            FROM "agents" AS "agent"
            WHERE "agent"."id" = "source".%4$I
          )
        ORDER BY %1$s
        LIMIT 500
        FOR UPDATE OF "source" SKIP LOCKED
      ),
      "updated" AS (
        UPDATE %2$s AS "target"
        SET %3$I = (
          SELECT "agent"."id"
          FROM "agents" AS "agent"
          WHERE "agent"."id" = "target".%4$I
        )
        FROM "batch"
        WHERE "target"."ctid" = "batch"."row_ctid"
        RETURNING "batch"."scan_key"
      )
      SELECT
        coalesce((SELECT max("scan_key") FROM "batch"), $1),
        (SELECT count(*) FROM "batch"),
        (SELECT count(*) FROM "updated")
      $query$,
      v_scan_key_expression,
      p_table,
      p_target_column,
      p_legacy_column
    )
    USING v_scan_after
    INTO v_next_scan_after, v_batch_count, v_updated_count;

    IF v_updated_count <> v_batch_count THEN
      RAISE EXCEPTION 'Canonical Agent reference backfill lost batch ownership';
    END IF;

    IF v_batch_count > 0 THEN
      v_scan_after := v_next_scan_after;
      v_no_progress_started_at := clock_timestamp();
    END IF;

    COMMIT;
    SET LOCAL lock_timeout = '1s';
    SET LOCAL transaction_timeout = '5min';

    IF v_batch_count > 0 THEN
      PERFORM pg_sleep(0.01);
      CONTINUE;
    END IF;

    EXECUTE format(
      $query$
      SELECT EXISTS (
        SELECT 1
        FROM %1$s AS "source"
        WHERE "source".%2$I IS DISTINCT FROM (
          SELECT "agent"."id"
          FROM "agents" AS "agent"
          WHERE "agent"."id" = "source".%3$I
        )
      )
      $query$,
      p_table,
      p_target_column,
      p_legacy_column
    ) INTO v_remaining;

    IF NOT v_remaining THEN
      EXIT;
    END IF;

    IF clock_timestamp() - v_no_progress_started_at >= p_no_progress_timeout THEN
      RAISE EXCEPTION 'Canonical Agent reference backfill made no progress for % while eligible rows remained',
        p_no_progress_timeout;
    END IF;

    v_scan_after := NULL;
    PERFORM pg_sleep(0.01);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- The large search projection uses its native (uuid, bigint) primary key as
-- the scan cursor. This keeps both the keyset predicate and ordering directly
-- usable by the existing composite primary-key index while preserving the
-- same restartable, short-transaction ownership contract as the small cohorts.
CREATE OR REPLACE PROCEDURE "backfill_chat_event_search_agent_references_0966"(
  p_no_progress_timeout interval
)
LANGUAGE plpgsql AS $$
DECLARE
  v_scan_after_chat_thread_id uuid := NULL;
  v_scan_after_seq_id bigint := NULL;
  v_scan_count integer;
  v_matched_count integer;
  v_updated_count integer;
  v_next_chat_thread_id uuid;
  v_next_seq_id bigint;
  v_remaining boolean;
  v_no_progress_started_at timestamp with time zone := clock_timestamp();
BEGIN
  IF
    p_no_progress_timeout IS NULL
    OR p_no_progress_timeout <= interval '0 seconds'
    OR p_no_progress_timeout > interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Canonical Agent search reference backfill no-progress timeout must be between 0 and 30 seconds';
  END IF;

  SET LOCAL lock_timeout = '1s';
  SET LOCAL transaction_timeout = '5min';

  LOOP
    WITH "scan" AS MATERIALIZED (
      SELECT
        "source"."ctid" AS "row_ctid",
        "source"."chat_thread_id",
        "source"."seq_id",
        "source"."agent_compose_id"
      FROM "chat_event_search_messages" AS "source"
      WHERE (
          v_scan_after_chat_thread_id IS NULL
          OR ("source"."chat_thread_id", "source"."seq_id") >
            (v_scan_after_chat_thread_id, v_scan_after_seq_id)
        )
        AND "source"."agent_id" IS DISTINCT FROM
          "source"."agent_compose_id"
      ORDER BY "source"."chat_thread_id", "source"."seq_id"
      LIMIT 500
      FOR UPDATE OF "source" SKIP LOCKED
    ),
    "batch" AS MATERIALIZED (
      SELECT "scan"."row_ctid", "scan"."chat_thread_id", "scan"."seq_id"
      FROM "scan"
      INNER JOIN "agents" AS "agent"
        ON "agent"."id" = "scan"."agent_compose_id"
    ),
    "updated" AS (
      UPDATE "chat_event_search_messages" AS "target"
      SET "agent_id" = "target"."agent_compose_id"
      FROM "batch"
      WHERE "target"."ctid" = "batch"."row_ctid"
      RETURNING "batch"."chat_thread_id", "batch"."seq_id"
    )
    SELECT
      coalesce(
        (
          SELECT "chat_thread_id"
          FROM "scan"
          ORDER BY "chat_thread_id" DESC, "seq_id" DESC
          LIMIT 1
        ),
        v_scan_after_chat_thread_id
      ),
      coalesce(
        (
          SELECT "seq_id"
          FROM "scan"
          ORDER BY "chat_thread_id" DESC, "seq_id" DESC
          LIMIT 1
        ),
        v_scan_after_seq_id
      ),
      (SELECT count(*) FROM "scan"),
      (SELECT count(*) FROM "batch"),
      (SELECT count(*) FROM "updated")
    INTO
      v_next_chat_thread_id,
      v_next_seq_id,
      v_scan_count,
      v_matched_count,
      v_updated_count;

    IF v_updated_count <> v_matched_count THEN
      RAISE EXCEPTION 'Canonical Agent search reference backfill lost batch ownership';
    END IF;

    IF v_scan_count > 0 THEN
      v_scan_after_chat_thread_id := v_next_chat_thread_id;
      v_scan_after_seq_id := v_next_seq_id;
    END IF;

    IF v_updated_count > 0 THEN
      v_no_progress_started_at := clock_timestamp();
    END IF;

    COMMIT;
    SET LOCAL lock_timeout = '1s';
    SET LOCAL transaction_timeout = '5min';

    IF v_scan_count > 0 THEN
      PERFORM pg_sleep(0.01);
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM "chat_event_search_messages" AS "source"
      INNER JOIN "agents" AS "agent"
        ON "agent"."id" = "source"."agent_compose_id"
      WHERE "source"."agent_id" IS DISTINCT FROM
        "source"."agent_compose_id"
    )
    INTO v_remaining;

    IF NOT v_remaining THEN
      EXIT;
    END IF;

    IF clock_timestamp() - v_no_progress_started_at >= p_no_progress_timeout THEN
      RAISE EXCEPTION 'Canonical Agent search reference backfill made no progress for % while eligible rows remained',
        p_no_progress_timeout;
    END IF;

    v_scan_after_chat_thread_id := NULL;
    v_scan_after_seq_id := NULL;
    PERFORM pg_sleep(0.01);
  END LOOP;
END;
$$;
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.agent_sessions', ARRAY['id']::name[], 'agent_compose_id', 'agent_id', interval '30 seconds');
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.chat_threads', ARRAY['id']::name[], 'agent_compose_id', 'agent_id', interval '30 seconds');
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_thread_events'::regclass
      AND "tgname" = 'chat_thread_events_reject_update'
      AND "tgfoid" = 'public.reject_chat_event_source_update()'::regprocedure
      AND "tgenabled" = 'O'
      AND NOT "tgisinternal"
  ) THEN
    RAISE EXCEPTION 'chat_thread_events append-only trigger must be enabled';
  END IF;
END;
$$;
--> statement-breakpoint
-- Keep the permanent append-only trigger installed while narrowly permitting
-- only this deterministic reference transition. The target may move only from
-- NULL to the legacy compose id when that id already owns a canonical Agent;
-- every other column remains byte-identical and every other UPDATE still fails.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_SCHEMA = 'public'
    AND TG_TABLE_NAME = 'chat_thread_events'
    AND OLD."agent_id" IS NULL
    AND NEW."agent_id" = OLD."agent_compose_id"
    AND (to_jsonb(NEW) - 'agent_id') = (to_jsonb(OLD) - 'agent_id')
    AND EXISTS (
      SELECT 1
      FROM "agents" AS "agent"
      WHERE "agent"."id" = OLD."agent_compose_id"
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.chat_thread_events', ARRAY['id']::name[], 'agent_compose_id', 'agent_id', interval '30 seconds');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
SET statement_timeout = '2h';
--> statement-breakpoint
CALL "backfill_chat_event_search_agent_references_0966"(interval '30 seconds');
--> statement-breakpoint
SET statement_timeout = '30min';
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.telegram_installations', ARRAY['telegram_bot_id']::name[], 'default_compose_id', 'default_agent_id', interval '30 seconds');
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.feishu_org_installations', ARRAY['id']::name[], 'default_compose_id', 'default_agent_id', interval '30 seconds');
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.github_installations', ARRAY['id']::name[], 'default_compose_id', 'default_agent_id', interval '30 seconds');
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.slack_user_agent_preferences', ARRAY['user_id', 'org_id']::name[], 'selected_compose_id', 'selected_agent_id', interval '30 seconds');
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.teams_user_agent_preferences', ARRAY['user_id', 'org_id']::name[], 'selected_compose_id', 'selected_agent_id', interval '30 seconds');
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.agentphone_user_agent_preferences', ARRAY['user_id', 'org_id']::name[], 'selected_compose_id', 'selected_agent_id', interval '30 seconds');
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.telegram_user_agent_preferences', ARRAY['user_id', 'org_id']::name[], 'selected_compose_id', 'selected_agent_id', interval '30 seconds');
--> statement-breakpoint
CALL "backfill_agent_references_0966"('public.feishu_user_agent_preferences', ARRAY['user_id', 'org_id']::name[], 'selected_compose_id', 'selected_agent_id', interval '30 seconds');
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_chat_event_search_agent_references_0966"(interval);
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_agent_references_0966"(regclass, name[], name, name, interval);
--> statement-breakpoint

-- Recover only exact invalid artifacts, then build each replacement index in
-- its own concurrent statement. A valid exact retry artifact is retained.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
  v_spec record;
  v_relation_kind "char";
  v_definition text;
  v_ready boolean;
  v_valid boolean;
BEGIN
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('idx_agent_sessions_user_agent_0966_invalid', 'CREATE INDEX idx_agent_sessions_user_agent_0966_invalid ON public.agent_sessions USING btree (user_id, agent_id)'),
      ('chat_event_search_messages_user_org_agent_id_0966_invalid', 'CREATE INDEX chat_event_search_messages_user_org_agent_id_0966_invalid ON public.chat_event_search_messages USING btree (user_id, org_id, agent_id, created_at DESC NULLS LAST)'),
      ('idx_chat_threads_user_agent_updated_0966_invalid', 'CREATE INDEX idx_chat_threads_user_agent_updated_0966_invalid ON public.chat_threads USING btree (user_id, agent_id, updated_at DESC NULLS LAST)'),
      ('idx_chat_threads_user_agent_pinned_0966_invalid', 'CREATE INDEX idx_chat_threads_user_agent_pinned_0966_invalid ON public.chat_threads USING btree (user_id, agent_id) WHERE (pinned_at IS NOT NULL)'),
      ('idx_chat_threads_user_agent_last_message_0966_invalid', 'CREATE INDEX idx_chat_threads_user_agent_last_message_0966_invalid ON public.chat_threads USING btree (user_id, agent_id, last_message_at DESC NULLS LAST)')
    ) AS "spec"("name", "definition")
  LOOP
    SELECT
      "index_class"."relkind",
      pg_get_indexdef("index_class"."oid"),
      "index_row"."indisready",
      "index_row"."indisvalid"
    INTO v_relation_kind, v_definition, v_ready, v_valid
    FROM "pg_class" AS "index_class"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "index_class"."relnamespace"
    LEFT JOIN "pg_index" AS "index_row"
      ON "index_row"."indexrelid" = "index_class"."oid"
    WHERE "namespace"."nspname" = 'public'
      AND "index_class"."relname" = v_spec.name;

    IF FOUND AND (
      v_relation_kind <> 'i'
      OR v_definition IS DISTINCT FROM v_spec.definition
      OR v_ready IS NULL
      OR v_valid IS NULL
      OR v_valid
    ) THEN
      RAISE EXCEPTION 'Canonical Agent invalid-index recovery artifact % has conflicting definition or state',
        v_spec.name;
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_sessions_user_agent_0966_invalid";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_event_search_messages_user_org_agent_id_0966_invalid";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_threads_user_agent_updated_0966_invalid";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_threads_user_agent_pinned_0966_invalid";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_threads_user_agent_last_message_0966_invalid";
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
  v_spec record;
  v_relation_kind "char";
  v_definition text;
  v_ready boolean;
  v_valid boolean;
BEGIN
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('idx_agent_sessions_user_agent', 'idx_agent_sessions_user_agent_0966_invalid', 'CREATE INDEX idx_agent_sessions_user_agent ON public.agent_sessions USING btree (user_id, agent_id)'),
      ('chat_event_search_messages_user_org_agent_id_created_idx', 'chat_event_search_messages_user_org_agent_id_0966_invalid', 'CREATE INDEX chat_event_search_messages_user_org_agent_id_created_idx ON public.chat_event_search_messages USING btree (user_id, org_id, agent_id, created_at DESC NULLS LAST)'),
      ('idx_chat_threads_user_agent_updated', 'idx_chat_threads_user_agent_updated_0966_invalid', 'CREATE INDEX idx_chat_threads_user_agent_updated ON public.chat_threads USING btree (user_id, agent_id, updated_at DESC NULLS LAST)'),
      ('idx_chat_threads_user_agent_pinned', 'idx_chat_threads_user_agent_pinned_0966_invalid', 'CREATE INDEX idx_chat_threads_user_agent_pinned ON public.chat_threads USING btree (user_id, agent_id) WHERE (pinned_at IS NOT NULL)'),
      ('idx_chat_threads_user_agent_last_message', 'idx_chat_threads_user_agent_last_message_0966_invalid', 'CREATE INDEX idx_chat_threads_user_agent_last_message ON public.chat_threads USING btree (user_id, agent_id, last_message_at DESC NULLS LAST)')
    ) AS "spec"("name", "recovery_name", "definition")
  LOOP
    SELECT
      "index_class"."relkind",
      pg_get_indexdef("index_class"."oid"),
      "index_row"."indisready",
      "index_row"."indisvalid"
    INTO v_relation_kind, v_definition, v_ready, v_valid
    FROM "pg_class" AS "index_class"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "index_class"."relnamespace"
    LEFT JOIN "pg_index" AS "index_row"
      ON "index_row"."indexrelid" = "index_class"."oid"
    WHERE "namespace"."nspname" = 'public'
      AND "index_class"."relname" = v_spec.name;

    IF FOUND THEN
      IF v_relation_kind <> 'i' OR v_definition IS DISTINCT FROM v_spec.definition THEN
        RAISE EXCEPTION 'Canonical Agent replacement index % has a conflicting definition',
          v_spec.name;
      END IF;

      IF NOT v_ready OR NOT v_valid THEN
        EXECUTE format(
          'ALTER INDEX %I.%I RENAME TO %I',
          'public',
          v_spec.name,
          v_spec.recovery_name
        );
      END IF;
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_sessions_user_agent_0966_invalid";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_sessions_user_agent"
ON "agent_sessions" USING btree ("user_id", "agent_id");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_event_search_messages_user_org_agent_id_0966_invalid";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_event_search_messages_user_org_agent_id_created_idx"
ON "chat_event_search_messages" USING btree (
  "user_id", "org_id", "agent_id", "created_at" DESC NULLS LAST
);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_threads_user_agent_updated_0966_invalid";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_chat_threads_user_agent_updated"
ON "chat_threads" USING btree (
  "user_id", "agent_id", "updated_at" DESC NULLS LAST
);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_threads_user_agent_pinned_0966_invalid";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_chat_threads_user_agent_pinned"
ON "chat_threads" USING btree ("user_id", "agent_id")
WHERE "pinned_at" IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_chat_threads_user_agent_last_message_0966_invalid";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_chat_threads_user_agent_last_message"
ON "chat_threads" USING btree (
  "user_id", "agent_id", "last_message_at" DESC NULLS LAST
);
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
  v_spec record;
  v_definition text;
  v_ready boolean;
  v_valid boolean;
BEGIN
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('idx_agent_sessions_user_agent', 'CREATE INDEX idx_agent_sessions_user_agent ON public.agent_sessions USING btree (user_id, agent_id)'),
      ('chat_event_search_messages_user_org_agent_id_created_idx', 'CREATE INDEX chat_event_search_messages_user_org_agent_id_created_idx ON public.chat_event_search_messages USING btree (user_id, org_id, agent_id, created_at DESC NULLS LAST)'),
      ('idx_chat_threads_user_agent_updated', 'CREATE INDEX idx_chat_threads_user_agent_updated ON public.chat_threads USING btree (user_id, agent_id, updated_at DESC NULLS LAST)'),
      ('idx_chat_threads_user_agent_pinned', 'CREATE INDEX idx_chat_threads_user_agent_pinned ON public.chat_threads USING btree (user_id, agent_id) WHERE (pinned_at IS NOT NULL)'),
      ('idx_chat_threads_user_agent_last_message', 'CREATE INDEX idx_chat_threads_user_agent_last_message ON public.chat_threads USING btree (user_id, agent_id, last_message_at DESC NULLS LAST)')
    ) AS "spec"("name", "definition")
  LOOP
    SELECT
      pg_get_indexdef("index_class"."oid"),
      "index_row"."indisready",
      "index_row"."indisvalid"
    INTO v_definition, v_ready, v_valid
    FROM "pg_class" AS "index_class"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "index_class"."relnamespace"
    INNER JOIN "pg_index" AS "index_row"
      ON "index_row"."indexrelid" = "index_class"."oid"
    WHERE "namespace"."nspname" = 'public'
      AND "index_class"."relname" = v_spec.name
      AND "index_class"."relkind" = 'i';

    IF
      NOT FOUND
      OR v_definition IS DISTINCT FROM v_spec.definition
      OR NOT v_ready
      OR NOT v_valid
    THEN
      RAISE EXCEPTION 'Canonical Agent replacement index % is not exact, ready, and valid',
        v_spec.name;
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Add canonical target FKs and sibling-equality checks as NOT VALID. Each
-- helper CALL is its own short transaction and admits only the enumerated
-- table/column/delete-action contract.
CREATE OR REPLACE PROCEDURE "ensure_agent_foreign_key_0966"(
  p_table regclass,
  p_constraint name,
  p_column name,
  p_delete_action "char"
)
LANGUAGE plpgsql AS $$
DECLARE
  v_constraint "pg_constraint"%ROWTYPE;
  v_source_columns name[];
  v_target_columns name[];
  v_delete_sql text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.zero_agent_drafts'::regclass, 'zero_agent_drafts_agent_id_agents_id_fk'::name, 'agent_id'::name, 'c'::"char"),
      ('public.agent_sessions'::regclass, 'agent_sessions_agent_id_agents_id_fk'::name, 'agent_id'::name, 'c'::"char"),
      ('public.agentphone_user_agent_preferences'::regclass, 'agentphone_user_agent_preferences_selected_agent_id_agents_id_fk'::name, 'selected_agent_id'::name, 'n'::"char"),
      ('public.banking_agent_enablements'::regclass, 'banking_agent_enablements_agent_id_agents_id_fk'::name, 'agent_id'::name, 'c'::"char"),
      ('public.chat_threads'::regclass, 'chat_threads_agent_id_agents_id_fk'::name, 'agent_id'::name, 'c'::"char"),
      ('public.feishu_org_installations'::regclass, 'feishu_org_installations_default_agent_id_agents_id_fk'::name, 'default_agent_id'::name, 'c'::"char"),
      ('public.feishu_user_agent_preferences'::regclass, 'feishu_user_agent_preferences_selected_agent_id_agents_id_fk'::name, 'selected_agent_id'::name, 'n'::"char"),
      ('public.github_installations'::regclass, 'github_installations_default_agent_id_agents_id_fk'::name, 'default_agent_id'::name, 'c'::"char"),
      ('public.org_metadata'::regclass, 'org_metadata_default_agent_id_agents_id_fk'::name, 'default_agent_id'::name, 'n'::"char"),
      ('public.slack_user_agent_preferences'::regclass, 'slack_user_agent_preferences_selected_agent_id_agents_id_fk'::name, 'selected_agent_id'::name, 'n'::"char"),
      ('public.teams_user_agent_preferences'::regclass, 'teams_user_agent_preferences_selected_agent_id_agents_id_fk'::name, 'selected_agent_id'::name, 'n'::"char"),
      ('public.telegram_installations'::regclass, 'telegram_installations_default_agent_id_agents_id_fk'::name, 'default_agent_id'::name, 'c'::"char"),
      ('public.telegram_user_agent_preferences'::regclass, 'telegram_user_agent_preferences_selected_agent_id_agents_id_fk'::name, 'selected_agent_id'::name, 'n'::"char"),
      ('public.thread_goals'::regclass, 'thread_goals_agent_id_agents_id_fk'::name, 'agent_id'::name, 'c'::"char"),
      ('public.user_connectors'::regclass, 'user_connectors_agent_id_agents_id_fk'::name, 'agent_id'::name, 'c'::"char"),
      ('public.user_custom_connectors'::regclass, 'user_custom_connectors_agent_id_agents_id_fk'::name, 'agent_id'::name, 'c'::"char"),
      ('public.user_permission_grants'::regclass, 'user_permission_grants_agent_id_agents_id_fk'::name, 'agent_id'::name, 'c'::"char"),
      ('public.zero_workflows'::regclass, 'zero_workflows_agent_id_agents_id_fk'::name, 'agent_id'::name, 'c'::"char")
    ) AS "spec"("table_oid", "constraint_name", "column_name", "delete_action")
    WHERE "spec"."table_oid" = p_table
      AND "spec"."constraint_name" = p_constraint
      AND "spec"."column_name" = p_column
      AND "spec"."delete_action" = p_delete_action
  ) THEN
    RAISE EXCEPTION 'Unapproved canonical Agent foreign-key contract';
  END IF;

  SELECT *
  INTO v_constraint
  FROM "pg_constraint"
  WHERE "conrelid" = p_table
    AND "conname" = p_constraint;

  IF FOUND THEN
    SELECT array_agg("attribute"."attname" ORDER BY "key"."ordinality")
    INTO v_source_columns
    FROM unnest(v_constraint."conkey") WITH ORDINALITY
      AS "key"("attnum", "ordinality")
    INNER JOIN "pg_attribute" AS "attribute"
      ON "attribute"."attrelid" = v_constraint."conrelid"
      AND "attribute"."attnum" = "key"."attnum";

    SELECT array_agg("attribute"."attname" ORDER BY "key"."ordinality")
    INTO v_target_columns
    FROM unnest(v_constraint."confkey") WITH ORDINALITY
      AS "key"("attnum", "ordinality")
    INNER JOIN "pg_attribute" AS "attribute"
      ON "attribute"."attrelid" = v_constraint."confrelid"
      AND "attribute"."attnum" = "key"."attnum";

    IF
      v_constraint."contype" <> 'f'
      OR v_constraint."confrelid" <> 'public.agents'::regclass
      OR v_source_columns IS DISTINCT FROM ARRAY[p_column]::name[]
      OR v_target_columns IS DISTINCT FROM ARRAY['id']::name[]
      OR v_constraint."confdeltype" <> p_delete_action
      OR v_constraint."condeferrable"
      OR v_constraint."condeferred"
    THEN
      RAISE EXCEPTION 'Canonical Agent foreign key % has a conflicting contract',
        p_constraint;
    END IF;
    RETURN;
  END IF;

  v_delete_sql := CASE p_delete_action
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    ELSE NULL
  END;

  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.agents (id) ON DELETE %s NOT VALID',
    p_table,
    p_constraint,
    p_column,
    v_delete_sql
  );
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE "ensure_agent_reference_check_0966"(
  p_table regclass,
  p_constraint name,
  p_legacy_column name,
  p_target_column name
)
LANGUAGE plpgsql AS $$
DECLARE
  v_constraint "pg_constraint"%ROWTYPE;
  v_normalized_expression text;
  v_expected_expression text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.agent_sessions'::regclass, 'agent_sessions_agent_reference_match'::name, 'agent_compose_id'::name, 'agent_id'::name),
      ('public.chat_threads'::regclass, 'chat_threads_agent_reference_match'::name, 'agent_compose_id'::name, 'agent_id'::name),
      ('public.chat_thread_events'::regclass, 'chat_thread_events_agent_reference_match'::name, 'agent_compose_id'::name, 'agent_id'::name),
      ('public.chat_event_search_messages'::regclass, 'chat_event_search_messages_agent_reference_match'::name, 'agent_compose_id'::name, 'agent_id'::name),
      ('public.telegram_installations'::regclass, 'telegram_installations_agent_reference_match'::name, 'default_compose_id'::name, 'default_agent_id'::name),
      ('public.feishu_org_installations'::regclass, 'feishu_org_installations_agent_reference_match'::name, 'default_compose_id'::name, 'default_agent_id'::name),
      ('public.github_installations'::regclass, 'github_installations_agent_reference_match'::name, 'default_compose_id'::name, 'default_agent_id'::name),
      ('public.slack_user_agent_preferences'::regclass, 'slack_user_agent_preferences_agent_reference_match'::name, 'selected_compose_id'::name, 'selected_agent_id'::name),
      ('public.teams_user_agent_preferences'::regclass, 'teams_user_agent_preferences_agent_reference_match'::name, 'selected_compose_id'::name, 'selected_agent_id'::name),
      ('public.agentphone_user_agent_preferences'::regclass, 'agentphone_user_agent_preferences_agent_reference_match'::name, 'selected_compose_id'::name, 'selected_agent_id'::name),
      ('public.telegram_user_agent_preferences'::regclass, 'telegram_user_agent_preferences_agent_reference_match'::name, 'selected_compose_id'::name, 'selected_agent_id'::name),
      ('public.feishu_user_agent_preferences'::regclass, 'feishu_user_agent_preferences_agent_reference_match'::name, 'selected_compose_id'::name, 'selected_agent_id'::name)
    ) AS "spec"("table_oid", "constraint_name", "legacy_column", "target_column")
    WHERE "spec"."table_oid" = p_table
      AND "spec"."constraint_name" = p_constraint
      AND "spec"."legacy_column" = p_legacy_column
      AND "spec"."target_column" = p_target_column
  ) THEN
    RAISE EXCEPTION 'Unapproved canonical Agent reference check contract';
  END IF;

  v_expected_expression := lower(
    p_target_column::text || 'isnullornot' || p_target_column::text ||
    'isdistinctfrom' || p_legacy_column::text
  );

  SELECT *
  INTO v_constraint
  FROM "pg_constraint"
  WHERE "conrelid" = p_table
    AND "conname" = p_constraint;

  IF FOUND THEN
    v_normalized_expression := regexp_replace(
      lower(pg_get_expr(v_constraint."conbin", v_constraint."conrelid")),
      '["()[:space:]]',
      '',
      'g'
    );

    IF
      v_constraint."contype" <> 'c'
      OR v_normalized_expression IS DISTINCT FROM v_expected_expression
    THEN
      RAISE EXCEPTION 'Canonical Agent reference check % has a conflicting contract',
        p_constraint;
    END IF;
    RETURN;
  END IF;

  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IS NULL OR %I IS NOT DISTINCT FROM %I) NOT VALID',
    p_table,
    p_constraint,
    p_target_column,
    p_target_column,
    p_legacy_column
  );
END;
$$;
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.zero_agent_drafts', 'zero_agent_drafts_agent_id_agents_id_fk', 'agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.agent_sessions', 'agent_sessions_agent_id_agents_id_fk', 'agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.agentphone_user_agent_preferences', 'agentphone_user_agent_preferences_selected_agent_id_agents_id_fk', 'selected_agent_id', 'n');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.banking_agent_enablements', 'banking_agent_enablements_agent_id_agents_id_fk', 'agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.chat_threads', 'chat_threads_agent_id_agents_id_fk', 'agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.feishu_org_installations', 'feishu_org_installations_default_agent_id_agents_id_fk', 'default_agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.feishu_user_agent_preferences', 'feishu_user_agent_preferences_selected_agent_id_agents_id_fk', 'selected_agent_id', 'n');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.github_installations', 'github_installations_default_agent_id_agents_id_fk', 'default_agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.org_metadata', 'org_metadata_default_agent_id_agents_id_fk', 'default_agent_id', 'n');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.slack_user_agent_preferences', 'slack_user_agent_preferences_selected_agent_id_agents_id_fk', 'selected_agent_id', 'n');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.teams_user_agent_preferences', 'teams_user_agent_preferences_selected_agent_id_agents_id_fk', 'selected_agent_id', 'n');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.telegram_installations', 'telegram_installations_default_agent_id_agents_id_fk', 'default_agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.telegram_user_agent_preferences', 'telegram_user_agent_preferences_selected_agent_id_agents_id_fk', 'selected_agent_id', 'n');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.thread_goals', 'thread_goals_agent_id_agents_id_fk', 'agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.user_connectors', 'user_connectors_agent_id_agents_id_fk', 'agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.user_custom_connectors', 'user_custom_connectors_agent_id_agents_id_fk', 'agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.user_permission_grants', 'user_permission_grants_agent_id_agents_id_fk', 'agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_foreign_key_0966"('public.zero_workflows', 'zero_workflows_agent_id_agents_id_fk', 'agent_id', 'c');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.agent_sessions', 'agent_sessions_agent_reference_match', 'agent_compose_id', 'agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.chat_threads', 'chat_threads_agent_reference_match', 'agent_compose_id', 'agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.chat_thread_events', 'chat_thread_events_agent_reference_match', 'agent_compose_id', 'agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.chat_event_search_messages', 'chat_event_search_messages_agent_reference_match', 'agent_compose_id', 'agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.telegram_installations', 'telegram_installations_agent_reference_match', 'default_compose_id', 'default_agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.feishu_org_installations', 'feishu_org_installations_agent_reference_match', 'default_compose_id', 'default_agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.github_installations', 'github_installations_agent_reference_match', 'default_compose_id', 'default_agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.slack_user_agent_preferences', 'slack_user_agent_preferences_agent_reference_match', 'selected_compose_id', 'selected_agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.teams_user_agent_preferences', 'teams_user_agent_preferences_agent_reference_match', 'selected_compose_id', 'selected_agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.agentphone_user_agent_preferences', 'agentphone_user_agent_preferences_agent_reference_match', 'selected_compose_id', 'selected_agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.telegram_user_agent_preferences', 'telegram_user_agent_preferences_agent_reference_match', 'selected_compose_id', 'selected_agent_id');
--> statement-breakpoint
CALL "ensure_agent_reference_check_0966"('public.feishu_user_agent_preferences', 'feishu_user_agent_preferences_agent_reference_match', 'selected_compose_id', 'selected_agent_id');
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "ensure_agent_foreign_key_0966"(regclass, name, name, "char");
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "ensure_agent_reference_check_0966"(regclass, name, name, name);
--> statement-breakpoint

-- Validate one constraint at a time online. NOT VALID already protects every
-- write that commits after each preceding ADD CONSTRAINT.
SET statement_timeout = '5min';
--> statement-breakpoint
ALTER TABLE "zero_agent_drafts" VALIDATE CONSTRAINT "zero_agent_drafts_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" VALIDATE CONSTRAINT "agent_sessions_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agentphone_user_agent_preferences" VALIDATE CONSTRAINT "agentphone_user_agent_preferences_selected_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "banking_agent_enablements" VALIDATE CONSTRAINT "banking_agent_enablements_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_threads" VALIDATE CONSTRAINT "chat_threads_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "feishu_org_installations" VALIDATE CONSTRAINT "feishu_org_installations_default_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences" VALIDATE CONSTRAINT "feishu_user_agent_preferences_selected_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "github_installations" VALIDATE CONSTRAINT "github_installations_default_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "org_metadata" VALIDATE CONSTRAINT "org_metadata_default_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences" VALIDATE CONSTRAINT "slack_user_agent_preferences_selected_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences" VALIDATE CONSTRAINT "teams_user_agent_preferences_selected_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "telegram_installations" VALIDATE CONSTRAINT "telegram_installations_default_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences" VALIDATE CONSTRAINT "telegram_user_agent_preferences_selected_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "thread_goals" VALIDATE CONSTRAINT "thread_goals_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "user_connectors" VALIDATE CONSTRAINT "user_connectors_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "user_custom_connectors" VALIDATE CONSTRAINT "user_custom_connectors_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "user_permission_grants" VALIDATE CONSTRAINT "user_permission_grants_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_workflows" VALIDATE CONSTRAINT "zero_workflows_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" VALIDATE CONSTRAINT "agent_sessions_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "chat_threads" VALIDATE CONSTRAINT "chat_threads_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "chat_thread_events" VALIDATE CONSTRAINT "chat_thread_events_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "chat_event_search_messages" VALIDATE CONSTRAINT "chat_event_search_messages_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "telegram_installations" VALIDATE CONSTRAINT "telegram_installations_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "feishu_org_installations" VALIDATE CONSTRAINT "feishu_org_installations_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "github_installations" VALIDATE CONSTRAINT "github_installations_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences" VALIDATE CONSTRAINT "slack_user_agent_preferences_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences" VALIDATE CONSTRAINT "teams_user_agent_preferences_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "agentphone_user_agent_preferences" VALIDATE CONSTRAINT "agentphone_user_agent_preferences_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences" VALIDATE CONSTRAINT "telegram_user_agent_preferences_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences" VALIDATE CONSTRAINT "feishu_user_agent_preferences_agent_reference_match";
--> statement-breakpoint

-- Aggregate-only postflight: exact canonical parity, exact legacy-reference
-- equality, and only current compose-only identities or exact deleted-entity
-- snapshot anchors in chat_thread_events may retain a NULL sibling.
BEGIN;
--> statement-breakpoint
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
DO $$
DECLARE
  v_spec record;
  v_valid_missing bigint;
  v_mismatch bigint;
  v_target_only bigint;
  v_unclassified_null bigint;
  v_compose_only_null bigint;
  v_deleted_snapshot_anchor_null bigint;
  v_allowed_compose_only_null_total bigint := 0;
  v_allowed_deleted_snapshot_anchor_null_total bigint := 0;
  v_existing_final_missing bigint;
  v_existing_final_missing_total bigint := 0;
  v_matched_count bigint;
  v_target_count bigint;
  v_missing_target_count bigint;
  v_target_only_count bigint;
  v_field_mismatch_count bigint;
  v_bridge_trigger_count integer;
  v_target_trigger_count integer;
  v_validated_fk_count integer;
  v_validated_check_count integer;
  v_temporary_procedure_count integer;
BEGIN
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('public.agent_sessions'::regclass, 'agent_compose_id'::name, 'agent_id'::name, true),
      ('public.chat_threads'::regclass, 'agent_compose_id'::name, 'agent_id'::name, true),
      ('public.chat_thread_events'::regclass, 'agent_compose_id'::name, 'agent_id'::name, true),
      ('public.chat_event_search_messages'::regclass, 'agent_compose_id'::name, 'agent_id'::name, true),
      ('public.telegram_installations'::regclass, 'default_compose_id'::name, 'default_agent_id'::name, false),
      ('public.feishu_org_installations'::regclass, 'default_compose_id'::name, 'default_agent_id'::name, false),
      ('public.github_installations'::regclass, 'default_compose_id'::name, 'default_agent_id'::name, false),
      ('public.slack_user_agent_preferences'::regclass, 'selected_compose_id'::name, 'selected_agent_id'::name, false),
      ('public.teams_user_agent_preferences'::regclass, 'selected_compose_id'::name, 'selected_agent_id'::name, false),
      ('public.agentphone_user_agent_preferences'::regclass, 'selected_compose_id'::name, 'selected_agent_id'::name, false),
      ('public.telegram_user_agent_preferences'::regclass, 'selected_compose_id'::name, 'selected_agent_id'::name, false),
      ('public.feishu_user_agent_preferences'::regclass, 'selected_compose_id'::name, 'selected_agent_id'::name, false)
    ) AS "spec"("table_oid", "legacy_column", "target_column", "allows_compose_only")
  LOOP
    IF v_spec.table_oid = 'public.chat_thread_events'::regclass THEN
      SELECT
        count(*) FILTER (
          WHERE "source"."agent_compose_id" IS NOT NULL
            AND "source"."agent_id" IS NULL
            AND "agent"."id" IS NOT NULL
        ),
        count(*) FILTER (
          WHERE "source"."agent_id" IS NOT NULL
            AND "source"."agent_id" IS DISTINCT FROM "source"."agent_compose_id"
        ),
        count(*) FILTER (
          WHERE "source"."agent_id" IS NOT NULL
            AND "source"."agent_compose_id" IS NULL
        ),
        count(*) FILTER (
          WHERE "source"."agent_compose_id" IS NOT NULL
            AND "source"."agent_id" IS NULL
            AND "agent"."id" IS NULL
            AND NOT (
              "compose"."id" IS NOT NULL
              AND "zero_agent"."id" IS NULL
            )
            AND NOT (
              "compose"."id" IS NULL
              AND "zero_agent"."id" IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM "chat_threads" AS "live_thread"
                WHERE "live_thread"."id" = "source"."chat_thread_id"
              )
              AND EXISTS (
                SELECT 1
                FROM "chat_thread_snapshots" AS "snapshot"
                WHERE "snapshot"."user_id" = "source"."user_id"
                  AND "snapshot"."org_id" = "source"."org_id"
                  AND "snapshot"."latest_event_id" = "source"."id"
              )
            )
        ),
        count(*) FILTER (
          WHERE "source"."agent_compose_id" IS NOT NULL
            AND "source"."agent_id" IS NULL
            AND "agent"."id" IS NULL
            AND "compose"."id" IS NOT NULL
            AND "zero_agent"."id" IS NULL
        ),
        count(*) FILTER (
          WHERE "source"."agent_compose_id" IS NOT NULL
            AND "source"."agent_id" IS NULL
            AND "agent"."id" IS NULL
            AND "compose"."id" IS NULL
            AND "zero_agent"."id" IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM "chat_threads" AS "live_thread"
              WHERE "live_thread"."id" = "source"."chat_thread_id"
            )
            AND EXISTS (
              SELECT 1
              FROM "chat_thread_snapshots" AS "snapshot"
              WHERE "snapshot"."user_id" = "source"."user_id"
                AND "snapshot"."org_id" = "source"."org_id"
                AND "snapshot"."latest_event_id" = "source"."id"
            )
        )
      INTO
        v_valid_missing,
        v_mismatch,
        v_target_only,
        v_unclassified_null,
        v_compose_only_null,
        v_deleted_snapshot_anchor_null
      FROM "chat_thread_events" AS "source"
      LEFT JOIN "agents" AS "agent"
        ON "agent"."id" = "source"."agent_compose_id"
      LEFT JOIN "agent_composes" AS "compose"
        ON "compose"."id" = "source"."agent_compose_id"
      LEFT JOIN "zero_agents" AS "zero_agent"
        ON "zero_agent"."id" = "source"."agent_compose_id";
    ELSE
      v_deleted_snapshot_anchor_null := 0;

      EXECUTE format(
        $query$
        SELECT
          count(*) FILTER (
            WHERE "source".%1$I IS NOT NULL
              AND "source".%2$I IS NULL
              AND "agent"."id" IS NOT NULL
          ),
          count(*) FILTER (
            WHERE "source".%2$I IS NOT NULL
              AND "source".%2$I IS DISTINCT FROM "source".%1$I
          ),
          count(*) FILTER (
            WHERE "source".%2$I IS NOT NULL
              AND "source".%1$I IS NULL
          ),
          count(*) FILTER (
            WHERE "source".%1$I IS NOT NULL
              AND "source".%2$I IS NULL
              AND "agent"."id" IS NULL
              AND NOT (
                "compose"."id" IS NOT NULL
                AND "zero_agent"."id" IS NULL
              )
          ),
          count(*) FILTER (
            WHERE "source".%1$I IS NOT NULL
              AND "source".%2$I IS NULL
              AND "agent"."id" IS NULL
              AND "compose"."id" IS NOT NULL
              AND "zero_agent"."id" IS NULL
          )
        FROM %3$s AS "source"
        LEFT JOIN "agents" AS "agent"
          ON "agent"."id" = "source".%1$I
        LEFT JOIN "agent_composes" AS "compose"
          ON "compose"."id" = "source".%1$I
        LEFT JOIN "zero_agents" AS "zero_agent"
          ON "zero_agent"."id" = "source".%1$I
        $query$,
        v_spec.legacy_column,
        v_spec.target_column,
        v_spec.table_oid
      )
      INTO
        v_valid_missing,
        v_mismatch,
        v_target_only,
        v_unclassified_null,
        v_compose_only_null;
    END IF;

    IF
      v_valid_missing <> 0
      OR v_mismatch <> 0
      OR v_target_only <> 0
      OR v_unclassified_null <> 0
      OR (NOT v_spec.allows_compose_only AND v_compose_only_null <> 0)
    THEN
      RAISE EXCEPTION 'Canonical Agent reference parity failed for %: valid_missing %, mismatch %, target_only %, unclassified_null %, compose_only_null %, deleted_snapshot_anchor_null %',
        v_spec.table_oid,
        v_valid_missing,
        v_mismatch,
        v_target_only,
        v_unclassified_null,
        v_compose_only_null,
        v_deleted_snapshot_anchor_null;
    END IF;

    v_allowed_compose_only_null_total :=
      v_allowed_compose_only_null_total + v_compose_only_null;
    v_allowed_deleted_snapshot_anchor_null_total :=
      v_allowed_deleted_snapshot_anchor_null_total +
      v_deleted_snapshot_anchor_null;
  END LOOP;

  FOR v_spec IN
    SELECT * FROM (VALUES
      ('public.org_metadata'::regclass, 'default_agent_id'::name),
      ('public.zero_workflows'::regclass, 'agent_id'::name),
      ('public.user_connectors'::regclass, 'agent_id'::name),
      ('public.user_custom_connectors'::regclass, 'agent_id'::name),
      ('public.user_permission_grants'::regclass, 'agent_id'::name),
      ('public.zero_agent_drafts'::regclass, 'agent_id'::name),
      ('public.banking_agent_enablements'::regclass, 'agent_id'::name),
      ('public.thread_goals'::regclass, 'agent_id'::name)
    ) AS "spec"("table_oid", "column_name")
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s AS "source" LEFT JOIN "agents" AS "agent" ON "agent"."id" = "source".%I WHERE "source".%I IS NOT NULL AND "agent"."id" IS NULL',
      v_spec.table_oid,
      v_spec.column_name,
      v_spec.column_name
    ) INTO v_existing_final_missing;

    v_existing_final_missing_total :=
      v_existing_final_missing_total + v_existing_final_missing;
  END LOOP;

  IF v_existing_final_missing_total <> 0 THEN
    RAISE EXCEPTION 'Canonical Agent existing-final references have % missing targets',
      v_existing_final_missing_total;
  END IF;

  SELECT count(*)
  INTO v_matched_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id";

  SELECT count(*) INTO v_target_count FROM "agents";

  SELECT count(*)
  INTO v_missing_target_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  LEFT JOIN "agents" AS "agent"
    ON "agent"."id" = "compose"."id"
  WHERE "agent"."id" IS NULL;

  SELECT count(*)
  INTO v_target_only_count
  FROM "agents" AS "agent"
  LEFT JOIN "agent_composes" AS "compose"
    ON "compose"."id" = "agent"."id"
  LEFT JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "agent"."id"
  WHERE "compose"."id" IS NULL OR "zero_agent"."id" IS NULL;

  SELECT count(*)
  INTO v_field_mismatch_count
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  INNER JOIN "agents" AS "agent"
    ON "agent"."id" = "compose"."id"
  WHERE "compose"."org_id" IS DISTINCT FROM "zero_agent"."org_id"
    OR "compose"."user_id" IS DISTINCT FROM "zero_agent"."owner"
    OR "compose"."name" IS DISTINCT FROM "zero_agent"."name"
    OR ROW(
      "agent"."org_id", "agent"."owner", "agent"."name",
      "agent"."visibility", "agent"."display_name", "agent"."description",
      "agent"."sound", "agent"."avatar_url", "agent"."model_provider_id",
      "agent"."selected_model", "agent"."prefer_personal_provider",
      "agent"."created_at", "agent"."updated_at"
    ) IS DISTINCT FROM ROW(
      "zero_agent"."org_id", "zero_agent"."owner", "zero_agent"."name",
      "zero_agent"."visibility", "zero_agent"."display_name",
      "zero_agent"."description", "zero_agent"."sound",
      "zero_agent"."avatar_url", "zero_agent"."model_provider_id",
      "zero_agent"."selected_model", "zero_agent"."prefer_personal_provider",
      "compose"."created_at",
      greatest("compose"."updated_at", "zero_agent"."updated_at")
    );

  IF
    v_target_count <> v_matched_count
    OR v_missing_target_count <> 0
    OR v_target_only_count <> 0
    OR v_field_mismatch_count <> 0
  THEN
    RAISE EXCEPTION 'Canonical Agent final parity failed: matched %, target %, missing %, target_only %, field_mismatch %',
      v_matched_count,
      v_target_count,
      v_missing_target_count,
      v_target_only_count,
      v_field_mismatch_count;
  END IF;

  SELECT count(*)
  INTO v_bridge_trigger_count
  FROM "pg_trigger" AS "trigger"
  INNER JOIN "pg_proc" AS "function"
    ON "function"."oid" = "trigger"."tgfoid"
  WHERE NOT "trigger"."tgisinternal"
    AND "trigger"."tgenabled" = 'O'
    AND ("trigger"."tgrelid", "trigger"."tgname", "function"."proname") IN (
      ('public.agent_composes'::regclass, 'bridge_agent_composes_to_agents_0966', 'bridge_legacy_agent_to_agents_0966'),
      ('public.zero_agents'::regclass, 'bridge_zero_agents_to_agents_0966', 'bridge_legacy_agent_to_agents_0966'),
      ('public.agent_sessions'::regclass, 'bridge_agent_sessions_agent_reference_0966', 'bridge_agent_compose_reference_0966'),
      ('public.chat_threads'::regclass, 'bridge_chat_threads_agent_reference_0966', 'bridge_agent_compose_reference_0966'),
      ('public.chat_thread_events'::regclass, 'bridge_chat_thread_events_agent_reference_0966', 'bridge_agent_compose_reference_0966'),
      ('public.chat_event_search_messages'::regclass, 'bridge_chat_event_search_agent_reference_0966', 'bridge_agent_compose_reference_0966'),
      ('public.telegram_installations'::regclass, 'bridge_telegram_installations_agent_reference_0966', 'bridge_default_compose_reference_0966'),
      ('public.feishu_org_installations'::regclass, 'bridge_feishu_installations_agent_reference_0966', 'bridge_default_compose_reference_0966'),
      ('public.github_installations'::regclass, 'bridge_github_installations_agent_reference_0966', 'bridge_default_compose_reference_0966'),
      ('public.slack_user_agent_preferences'::regclass, 'bridge_slack_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966'),
      ('public.teams_user_agent_preferences'::regclass, 'bridge_teams_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966'),
      ('public.agentphone_user_agent_preferences'::regclass, 'bridge_agentphone_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966'),
      ('public.telegram_user_agent_preferences'::regclass, 'bridge_telegram_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966'),
      ('public.feishu_user_agent_preferences'::regclass, 'bridge_feishu_preferences_agent_reference_0966', 'bridge_selected_compose_reference_0966')
    );

  IF v_bridge_trigger_count <> 14 THEN
    RAISE EXCEPTION 'Canonical Agent bridge catalog has % of 14 exact enabled trigger/function pairs',
      v_bridge_trigger_count;
  END IF;

  SELECT count(*)
  INTO v_target_trigger_count
  FROM "pg_trigger"
  WHERE "tgrelid" = 'public.agents'::regclass
    AND NOT "tgisinternal";

  IF v_target_trigger_count <> 0 THEN
    RAISE EXCEPTION 'Canonical agents table has % forbidden reverse triggers',
      v_target_trigger_count;
  END IF;

  SELECT count(*)
  INTO v_validated_fk_count
  FROM "pg_constraint"
  WHERE "confrelid" = 'public.agents'::regclass
    AND "contype" = 'f'
    AND "convalidated";

  SELECT count(*)
  INTO v_validated_check_count
  FROM "pg_constraint"
  WHERE "contype" = 'c'
    AND "convalidated"
    AND "conname" = ANY(ARRAY[
      'agent_sessions_agent_reference_match',
      'chat_threads_agent_reference_match',
      'chat_thread_events_agent_reference_match',
      'chat_event_search_messages_agent_reference_match',
      'telegram_installations_agent_reference_match',
      'feishu_org_installations_agent_reference_match',
      'github_installations_agent_reference_match',
      'slack_user_agent_preferences_agent_reference_match',
      'teams_user_agent_preferences_agent_reference_match',
      'agentphone_user_agent_preferences_agent_reference_match',
      'telegram_user_agent_preferences_agent_reference_match',
      'feishu_user_agent_preferences_agent_reference_match'
    ]::name[]);

  IF v_validated_fk_count <> 18 OR v_validated_check_count <> 12 THEN
    RAISE EXCEPTION 'Canonical Agent online constraints incomplete: validated_fks %, validated_checks %',
      v_validated_fk_count,
      v_validated_check_count;
  END IF;

  SELECT count(*)
  INTO v_temporary_procedure_count
  FROM "pg_proc"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "pg_proc"."pronamespace"
  WHERE "namespace"."nspname" = 'public'
    AND "pg_proc"."proname" = ANY(ARRAY[
      'backfill_agents_0966',
      'backfill_agent_references_0966',
      'backfill_chat_event_search_agent_references_0966',
      'ensure_agent_foreign_key_0966',
      'ensure_agent_reference_check_0966'
    ]);

  IF v_temporary_procedure_count <> 0 THEN
    RAISE EXCEPTION 'Canonical Agent migration left % temporary procedures',
      v_temporary_procedure_count;
  END IF;

  RAISE NOTICE 'Canonical Agent postflight: matched=%, target=%, allowed_compose_only_null_references=%, allowed_deleted_snapshot_anchor_null_references=%, existing_final_missing=%, bridges=%, validated_fks=%, validated_checks=%',
    v_matched_count,
    v_target_count,
    v_allowed_compose_only_null_total,
    v_allowed_deleted_snapshot_anchor_null_total,
    v_existing_final_missing_total,
    v_bridge_trigger_count,
    v_validated_fk_count,
    v_validated_check_count;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
