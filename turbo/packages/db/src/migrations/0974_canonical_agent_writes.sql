-- vm0:non-transactional
-- #28703 / #26938 rolling compatibility boundary for canonical Agent writers.
-- The legacy-to-canonical bridge remains one-way for outgoing Stage 6 API
-- revisions. Incoming Stage 7 revisions write only canonical columns.

SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "agent_compose_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_threads" ALTER COLUMN "agent_compose_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_thread_events" ALTER COLUMN "agent_compose_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_event_search_messages" ALTER COLUMN "agent_compose_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "telegram_installations" ALTER COLUMN "default_compose_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ALTER COLUMN "default_compose_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "github_installations" ALTER COLUMN "default_compose_id" DROP NOT NULL;
--> statement-breakpoint
-- The canonical default already has its agents(id) FK. Remove the obsolete
-- cross-shape FK that otherwise requires every Stage 7 default to keep an
-- agent_composes anchor.
ALTER TABLE "org_metadata"
  DROP CONSTRAINT IF EXISTS "org_metadata_default_agent_id_agent_composes_id_fk";
--> statement-breakpoint
-- Canonical dependent-reference columns already have agents(id) FKs. Remove
-- only their obsolete cross-shape FKs to zero_agents so a Stage 7 Agent can
-- own dependent state without a forbidden zero_agents dual write. Legacy
-- sibling columns and every FK/index attached to those siblings remain.
ALTER TABLE "banking_agent_enablements"
  DROP CONSTRAINT IF EXISTS "banking_agent_enablements_agent_id_zero_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "thread_goals"
  DROP CONSTRAINT IF EXISTS "thread_goals_agent_id_zero_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "user_connectors"
  DROP CONSTRAINT IF EXISTS "user_connectors_agent_id_zero_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "user_custom_connectors"
  DROP CONSTRAINT IF EXISTS "user_custom_connectors_agent_id_zero_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "user_permission_grants"
  DROP CONSTRAINT IF EXISTS "user_permission_grants_agent_id_zero_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_agent_drafts"
  DROP CONSTRAINT IF EXISTS "zero_agent_drafts_agent_id_zero_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "zero_workflows"
  DROP CONSTRAINT IF EXISTS "zero_workflows_agent_id_zero_agents_id_fk";
--> statement-breakpoint

-- Retain sibling equality only for immutable reference identities. Mutable
-- installation defaults require at least one sibling during the rollout, and
-- nullable preference rows may diverge or clear both siblings. NOT VALID
-- enforces each retained contract for new writes before online validation.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "agent_sessions"
  DROP CONSTRAINT IF EXISTS "agent_sessions_agent_reference_match",
  ADD CONSTRAINT "agent_sessions_agent_reference_match"
    CHECK ("agent_id" IS NULL OR "agent_compose_id" IS NULL OR "agent_id" IS NOT DISTINCT FROM "agent_compose_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "chat_threads"
  DROP CONSTRAINT IF EXISTS "chat_threads_agent_reference_match",
  ADD CONSTRAINT "chat_threads_agent_reference_match"
    CHECK ("agent_id" IS NULL OR "agent_compose_id" IS NULL OR "agent_id" IS NOT DISTINCT FROM "agent_compose_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "chat_thread_events"
  DROP CONSTRAINT IF EXISTS "chat_thread_events_agent_reference_match",
  ADD CONSTRAINT "chat_thread_events_agent_reference_match"
    CHECK ("agent_id" IS NULL OR "agent_compose_id" IS NULL OR "agent_id" IS NOT DISTINCT FROM "agent_compose_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "chat_event_search_messages"
  DROP CONSTRAINT IF EXISTS "chat_event_search_messages_agent_reference_match",
  ADD CONSTRAINT "chat_event_search_messages_agent_reference_match"
    CHECK ("agent_id" IS NULL OR "agent_compose_id" IS NULL OR "agent_id" IS NOT DISTINCT FROM "agent_compose_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "telegram_installations"
  DROP CONSTRAINT IF EXISTS "telegram_installations_agent_reference_match",
  ADD CONSTRAINT "telegram_installations_agent_reference_match"
    CHECK ("default_agent_id" IS NOT NULL OR "default_compose_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "feishu_org_installations"
  DROP CONSTRAINT IF EXISTS "feishu_org_installations_agent_reference_match",
  ADD CONSTRAINT "feishu_org_installations_agent_reference_match"
    CHECK ("default_agent_id" IS NOT NULL OR "default_compose_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "github_installations"
  DROP CONSTRAINT IF EXISTS "github_installations_agent_reference_match",
  ADD CONSTRAINT "github_installations_agent_reference_match"
    CHECK ("default_agent_id" IS NULL OR "default_compose_id" IS NULL OR "default_agent_id" IS NOT DISTINCT FROM "default_compose_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "slack_user_agent_preferences"
  DROP CONSTRAINT IF EXISTS "slack_user_agent_preferences_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "teams_user_agent_preferences"
  DROP CONSTRAINT IF EXISTS "teams_user_agent_preferences_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "agentphone_user_agent_preferences"
  DROP CONSTRAINT IF EXISTS "agentphone_user_agent_preferences_agent_reference_match",
  ADD CONSTRAINT "agentphone_user_agent_preferences_agent_reference_match"
    CHECK ("selected_agent_id" IS NULL OR "selected_compose_id" IS NULL OR "selected_agent_id" IS NOT DISTINCT FROM "selected_compose_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences"
  DROP CONSTRAINT IF EXISTS "telegram_user_agent_preferences_agent_reference_match";
--> statement-breakpoint
ALTER TABLE "feishu_user_agent_preferences"
  DROP CONSTRAINT IF EXISTS "feishu_user_agent_preferences_agent_reference_match";
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Stage 7 canonical INSERTs preserve an explicitly supplied canonical UUID.
-- Legacy INSERT/UPDATE writes still mirror the legacy sibling, including NULL.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bridge_agent_compose_reference_0966"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."agent_id" IS NOT NULL THEN
    RETURN NEW;
  END IF;

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
  IF TG_OP = 'INSERT' AND NEW."default_agent_id" IS NOT NULL THEN
    RETURN NEW;
  END IF;

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
  IF TG_OP = 'INSERT' AND NEW."selected_agent_id" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT "agent"."id"
  INTO NEW."selected_agent_id"
  FROM "agents" AS "agent"
  WHERE "agent"."id" = NEW."selected_compose_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- UPDATEs synchronize only an existing canonical Agent. That prevents an
-- outgoing Stage 6 UPDATE from recreating an Agent deleted by Stage 7.
CREATE OR REPLACE FUNCTION "sync_agent_from_legacy_0966"(
  p_agent_id uuid
) RETURNS void AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('canonical-agent:' || p_agent_id::text, 0)
  );

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

  UPDATE "agents" AS "agent"
  SET
    "org_id" = "zero_agent"."org_id",
    "owner" = "zero_agent"."owner",
    "name" = "zero_agent"."name",
    "visibility" = "zero_agent"."visibility",
    "display_name" = "zero_agent"."display_name",
    "description" = "zero_agent"."description",
    "sound" = "zero_agent"."sound",
    "avatar_url" = "zero_agent"."avatar_url",
    "model_provider_id" = "zero_agent"."model_provider_id",
    "selected_model" = "zero_agent"."selected_model",
    "prefer_personal_provider" = "zero_agent"."prefer_personal_provider",
    "created_at" = "compose"."created_at",
    "updated_at" = greatest("compose"."updated_at", "zero_agent"."updated_at")
  FROM "agent_composes" AS "compose"
  INNER JOIN "zero_agents" AS "zero_agent"
    ON "zero_agent"."id" = "compose"."id"
  WHERE "agent"."id" = p_agent_id
    AND "compose"."id" = p_agent_id
    AND "compose"."org_id" IS NOT DISTINCT FROM "zero_agent"."org_id"
    AND "compose"."user_id" IS NOT DISTINCT FROM "zero_agent"."owner"
    AND "compose"."name" IS NOT DISTINCT FROM "zero_agent"."name";
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "bridge_legacy_agent_to_agents_0966"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('canonical-agent:' || NEW."id"::text, 0)
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
    WHERE "compose"."id" = NEW."id"
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
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM "sync_agent_from_legacy_0966"(OLD."id");
    RETURN OLD;
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id" THEN
    PERFORM "sync_agent_from_legacy_0966"(OLD."id");
  END IF;

  PERFORM "sync_agent_from_legacy_0966"(NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Validate one replacement at a time without holding an ACCESS EXCLUSIVE
-- table lock for the scan. The one-second lock timeout remains in force.
SET statement_timeout = '2h';
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
ALTER TABLE "agentphone_user_agent_preferences" VALIDATE CONSTRAINT "agentphone_user_agent_preferences_agent_reference_match";
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
