-- vm0:non-transactional
-- Canonicalize the exact legacy model-provider discriminator while old
-- application versions may still write it. The bridges intentionally remain
-- installed after this migration for rollback and old-client safety.
-- Remove them only in #28368's later contract release after #29910 is
-- production-accepted, exact legacy writes remain zero for seven days, and
-- rollback plus supported immutable-client contexts have drained.

SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '0';--> statement-breakpoint

CREATE OR REPLACE FUNCTION "canonicalize_agent_run_builtin_provider"()
RETURNS trigger AS $$
BEGIN
  IF NEW."model_provider" = 'vm0' THEN
    NEW."model_provider" := 'built-in';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.agent_runs'::regclass
      AND "tgname" = 'canonicalize_agent_run_builtin_provider'
      AND NOT "tgisinternal"
  ) THEN
    CREATE TRIGGER "canonicalize_agent_run_builtin_provider"
    BEFORE INSERT OR UPDATE OF "model_provider" ON "agent_runs"
    FOR EACH ROW
    EXECUTE FUNCTION "canonicalize_agent_run_builtin_provider"();
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "canonicalize_chat_thread_builtin_provider"()
RETURNS trigger AS $$
BEGIN
  IF NEW."model_provider_type" = 'vm0' THEN
    NEW."model_provider_type" := 'built-in';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_threads'::regclass
      AND "tgname" = 'canonicalize_chat_thread_builtin_provider'
      AND NOT "tgisinternal"
  ) THEN
    CREATE TRIGGER "canonicalize_chat_thread_builtin_provider"
    BEFORE INSERT OR UPDATE OF "model_provider_type" ON "chat_threads"
    FOR EACH ROW
    EXECUTE FUNCTION "canonicalize_chat_thread_builtin_provider"();
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "canonicalize_org_model_policy_builtin_provider"()
RETURNS trigger AS $$
BEGIN
  IF NEW."default_provider_type" = 'vm0' THEN
    NEW."default_provider_type" := 'built-in';
  END IF;

  IF NEW."default_provider_type" = 'built-in'
    AND (NEW."model_provider_id" IS NOT NULL OR NEW."model_provider_surface_id" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'built-in org model policy routes cannot reference a provider id'
      USING ERRCODE = '23514',
        CONSTRAINT = 'chk_org_model_policies_builtin_route_no_provider_id';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.org_model_policies'::regclass
      AND "tgname" = 'canonicalize_org_model_policy_builtin_provider'
      AND NOT "tgisinternal"
  ) THEN
    CREATE TRIGGER "canonicalize_org_model_policy_builtin_provider"
    BEFORE INSERT OR UPDATE OF "default_provider_type", "model_provider_id", "model_provider_surface_id" ON "org_model_policies"
    FOR EACH ROW
    EXECUTE FUNCTION "canonicalize_org_model_policy_builtin_provider"();
  END IF;
END;
$$;--> statement-breakpoint

-- model_providers needs a specialized bridge because its discriminator is part
-- of the (org_id, user_id, type) conflict target. When a legacy row exists, an
-- INSERT keeps the legacy value long enough for ON CONFLICT to select that
-- exact row; the conflict UPDATE then canonicalizes the original row in place.
CREATE OR REPLACE FUNCTION "canonicalize_model_provider_builtin_type"()
RETURNS trigger AS $$
DECLARE
  legacy_id uuid;
BEGIN
  IF TG_OP = 'INSERT' AND NEW."type" IN ('vm0', 'built-in') THEN
    SELECT "id"
    INTO legacy_id
    FROM "model_providers"
    WHERE "org_id" = NEW."org_id"
      AND "user_id" = NEW."user_id"
      AND "type" = 'vm0'
    FOR UPDATE;

    IF legacy_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1
        FROM "model_providers"
        WHERE "org_id" = NEW."org_id"
          AND "user_id" = NEW."user_id"
          AND "type" = 'built-in'
      ) THEN
        RAISE EXCEPTION 'model_providers contains both vm0 and built-in for org %, user %', NEW."org_id", NEW."user_id"
          USING ERRCODE = '23505',
            CONSTRAINT = 'idx_model_providers_org_user_type';
      END IF;
      NEW."type" := 'vm0';
    ELSE
      NEW."type" := 'built-in';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW."type" IN ('vm0', 'built-in') THEN
    IF EXISTS (
      SELECT 1
      FROM "model_providers"
      WHERE "org_id" = NEW."org_id"
        AND "user_id" = NEW."user_id"
        AND "type" IN ('vm0', 'built-in')
        AND "id" <> NEW."id"
    ) THEN
      RAISE EXCEPTION 'model_providers contains both vm0 and built-in for org %, user %', NEW."org_id", NEW."user_id"
        USING ERRCODE = '23505',
          CONSTRAINT = 'idx_model_providers_org_user_type';
    END IF;
    NEW."type" := 'built-in';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.model_providers'::regclass
      AND "tgname" = 'canonicalize_model_provider_builtin_type'
      AND NOT "tgisinternal"
  ) THEN
    CREATE TRIGGER "canonicalize_model_provider_builtin_type"
    BEFORE INSERT OR UPDATE ON "model_providers"
    FOR EACH ROW
    EXECUTE FUNCTION "canonicalize_model_provider_builtin_type"();
  END IF;
END;
$$;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_index" AS "index"
    JOIN "pg_class" AS "relation" ON "relation"."oid" = "index"."indexrelid"
    WHERE "index"."indrelid" = 'public.model_providers'::regclass
      AND "relation"."relname" = 'idx_model_providers_org_user_type'
      AND "index"."indisunique"
      AND "index"."indpred" IS NULL
      AND pg_get_indexdef("index"."indexrelid") = 'CREATE UNIQUE INDEX idx_model_providers_org_user_type ON public.model_providers USING btree (org_id, user_id, type)'
  ) THEN
    RAISE EXCEPTION 'model_providers provider-identity unique index drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "model_providers"
    WHERE "type" IN ('vm0', 'built-in')
    GROUP BY "org_id", "user_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'model_providers contains a vm0/built-in identity collision';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE PROCEDURE "backfill_builtin_provider_discriminator"(
  target_table regclass,
  target_column name
)
LANGUAGE plpgsql AS $$
DECLARE
  batch_count integer;
BEGIN
  LOOP
    EXECUTE format(
      'WITH batch AS (
        SELECT "id"
        FROM %s
        WHERE %I = ''vm0''
        ORDER BY "id"
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
      )
      UPDATE %s AS target
      SET %I = ''built-in''
      FROM batch
      WHERE target."id" = batch."id"',
      target_table,
      target_column,
      target_table,
      target_column
    );
    GET DIAGNOSTICS batch_count = ROW_COUNT;
    COMMIT;
    EXIT WHEN batch_count = 0;
  END LOOP;
END;
$$;--> statement-breakpoint

CALL "backfill_builtin_provider_discriminator"('public.agent_runs', 'model_provider');--> statement-breakpoint
CALL "backfill_builtin_provider_discriminator"('public.chat_threads', 'model_provider_type');--> statement-breakpoint
CALL "backfill_builtin_provider_discriminator"('public.org_model_policies', 'default_provider_type');--> statement-breakpoint
CALL "backfill_builtin_provider_discriminator"('public.model_providers', 'type');--> statement-breakpoint
DROP PROCEDURE "backfill_builtin_provider_discriminator"(regclass, name);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_runs" WHERE "model_provider" = 'vm0')
    OR EXISTS (SELECT 1 FROM "chat_threads" WHERE "model_provider_type" = 'vm0')
    OR EXISTS (SELECT 1 FROM "org_model_policies" WHERE "default_provider_type" = 'vm0')
    OR EXISTS (SELECT 1 FROM "model_providers" WHERE "type" = 'vm0')
  THEN
    RAISE EXCEPTION 'legacy vm0 provider discriminators remain; retry the migration after concurrent locks clear';
  END IF;
END;
$$;--> statement-breakpoint

RESET statement_timeout;--> statement-breakpoint
RESET lock_timeout;
