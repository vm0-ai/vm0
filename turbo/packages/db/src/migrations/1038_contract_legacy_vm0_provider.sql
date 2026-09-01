SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Keep the bridge-protected sweep, zero-residual assertion, and bridge removal
-- in one transaction with no concurrent writer between them.
LOCK TABLE
  "agent_runs",
  "chat_threads",
  "model_providers",
  "org_model_policies"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

-- Fail closed before changing data or removing compatibility objects. The
-- provider identity checks intentionally match migration 1014's accepted
-- unique-index and alias-collision contracts exactly.
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

  IF (
    SELECT count(*)
    FROM "pg_trigger"
    WHERE "tgname" IN (
      'canonicalize_agent_run_builtin_provider',
      'canonicalize_chat_thread_builtin_provider',
      'canonicalize_model_provider_builtin_type',
      'canonicalize_org_model_policy_builtin_provider'
    )
      AND NOT "tgisinternal"
  ) <> 4 OR (
    SELECT count(*)
    FROM "pg_trigger"
    WHERE NOT "tgisinternal"
      AND "tgenabled" = 'O'
      AND (
        (
          "tgrelid" = 'public.agent_runs'::regclass
          AND "tgname" = 'canonicalize_agent_run_builtin_provider'
          AND pg_get_triggerdef("oid") = 'CREATE TRIGGER canonicalize_agent_run_builtin_provider BEFORE INSERT OR UPDATE OF model_provider ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION canonicalize_agent_run_builtin_provider()'
        ) OR (
          "tgrelid" = 'public.chat_threads'::regclass
          AND "tgname" = 'canonicalize_chat_thread_builtin_provider'
          AND pg_get_triggerdef("oid") = 'CREATE TRIGGER canonicalize_chat_thread_builtin_provider BEFORE INSERT OR UPDATE OF model_provider_type ON public.chat_threads FOR EACH ROW EXECUTE FUNCTION canonicalize_chat_thread_builtin_provider()'
        ) OR (
          "tgrelid" = 'public.model_providers'::regclass
          AND "tgname" = 'canonicalize_model_provider_builtin_type'
          AND pg_get_triggerdef("oid") = 'CREATE TRIGGER canonicalize_model_provider_builtin_type BEFORE INSERT OR UPDATE ON public.model_providers FOR EACH ROW EXECUTE FUNCTION canonicalize_model_provider_builtin_type()'
        ) OR (
          "tgrelid" = 'public.org_model_policies'::regclass
          AND "tgname" = 'canonicalize_org_model_policy_builtin_provider'
          AND pg_get_triggerdef("oid") = 'CREATE TRIGGER canonicalize_org_model_policy_builtin_provider BEFORE INSERT OR UPDATE OF default_provider_type, model_provider_id, model_provider_surface_id ON public.org_model_policies FOR EACH ROW EXECUTE FUNCTION canonicalize_org_model_policy_builtin_provider()'
        )
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'built-in provider bridge trigger identity drifted';
  END IF;

  IF (
    SELECT count(*)
    FROM "pg_proc" AS "function"
    JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "function"."pronamespace"
    WHERE "namespace"."nspname" = 'public'
      AND "function"."proname" IN (
        'canonicalize_agent_run_builtin_provider',
        'canonicalize_chat_thread_builtin_provider',
        'canonicalize_model_provider_builtin_type',
        'canonicalize_org_model_policy_builtin_provider'
      )
  ) <> 4 OR (
    SELECT count(*)
    FROM "pg_proc" AS "function"
    JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "function"."pronamespace"
    JOIN "pg_language" AS "language"
      ON "language"."oid" = "function"."prolang"
    WHERE "namespace"."nspname" = 'public'
      AND "function"."prokind" = 'f'
      AND pg_get_function_identity_arguments("function"."oid") = ''
      AND pg_get_function_result("function"."oid") = 'trigger'
      AND "language"."lanname" = 'plpgsql'
      AND NOT "function"."prosecdef"
      AND NOT "function"."proisstrict"
      AND "function"."provolatile" = 'v'
      AND "function"."proparallel" = 'u'
      AND (
        (
          "function"."proname" = 'canonicalize_agent_run_builtin_provider'
          AND md5("function"."prosrc") = '08ccacae72d432c06fecb49b4f01dcbf'
        ) OR (
          "function"."proname" = 'canonicalize_chat_thread_builtin_provider'
          AND md5("function"."prosrc") = '8184f2daa343c7eb811308c17a6a2b65'
        ) OR (
          "function"."proname" = 'canonicalize_model_provider_builtin_type'
          AND md5("function"."prosrc") = '90eafccc4fe3a0ffa32dec184c340e77'
        ) OR (
          "function"."proname" = 'canonicalize_org_model_policy_builtin_provider'
          AND md5("function"."prosrc") = 'dfd0098b8afe609bbbcd336b22f6ec3b'
        )
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'built-in provider bridge function identity drifted';
  END IF;
END;
$$;--> statement-breakpoint

-- Idempotent final sweep while all four exact-value bridges are still present.
UPDATE "agent_runs"
SET "model_provider" = 'built-in'
WHERE "model_provider" = 'vm0';--> statement-breakpoint

UPDATE "chat_threads"
SET "model_provider_type" = 'built-in'
WHERE "model_provider_type" = 'vm0';--> statement-breakpoint

UPDATE "org_model_policies"
SET "default_provider_type" = 'built-in'
WHERE "default_provider_type" = 'vm0';--> statement-breakpoint

UPDATE "model_providers"
SET "type" = 'built-in'
WHERE "type" = 'vm0';--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_runs" WHERE "model_provider" = 'vm0')
    OR EXISTS (SELECT 1 FROM "chat_threads" WHERE "model_provider_type" = 'vm0')
    OR EXISTS (SELECT 1 FROM "org_model_policies" WHERE "default_provider_type" = 'vm0')
    OR EXISTS (SELECT 1 FROM "model_providers" WHERE "type" = 'vm0')
  THEN
    RAISE EXCEPTION 'legacy vm0 provider discriminators remain after the final sweep';
  END IF;
END;
$$;--> statement-breakpoint

DROP TRIGGER "canonicalize_agent_run_builtin_provider" ON "agent_runs";--> statement-breakpoint
DROP TRIGGER "canonicalize_chat_thread_builtin_provider" ON "chat_threads";--> statement-breakpoint
DROP TRIGGER "canonicalize_model_provider_builtin_type" ON "model_providers";--> statement-breakpoint
DROP TRIGGER "canonicalize_org_model_policy_builtin_provider" ON "org_model_policies";--> statement-breakpoint

DROP FUNCTION "canonicalize_agent_run_builtin_provider"();--> statement-breakpoint
DROP FUNCTION "canonicalize_chat_thread_builtin_provider"();--> statement-breakpoint
DROP FUNCTION "canonicalize_model_provider_builtin_type"();--> statement-breakpoint
DROP FUNCTION "canonicalize_org_model_policy_builtin_provider"();
