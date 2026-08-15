-- Canonicalize the small persisted DeepSeek provider cohort without schema
-- changes or explicit table locks. The migration keeps each provider UUID and
-- secret_id intact, so existing policy and thread references continue to point
-- at the same credential.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Refuse to guess which credential should win if canonical and legacy rows
-- coexist for the same owner. Production was audited before this migration and
-- has eight legacy rows and no canonical rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "model_providers" AS "legacy"
    INNER JOIN "model_providers" AS "canonical"
      ON "canonical"."org_id" = "legacy"."org_id"
      AND "canonical"."user_id" = "legacy"."user_id"
      AND "canonical"."type" = 'deepseek'
    WHERE "legacy"."type" IN ('deepseek-api-key', 'deepseek-codex')
  ) THEN
    RAISE EXCEPTION 'Canonical and legacy DeepSeek providers coexist for one owner';
  END IF;
END;
$$;--> statement-breakpoint

UPDATE "model_providers"
SET "type" = 'deepseek',
    "selected_model" = 'deepseek-v4-flash',
    "updated_at" = NOW()
WHERE "type" IN ('deepseek-api-key', 'deepseek-codex');--> statement-breakpoint

-- V4 Pro no longer has a supported route. Preserve the user's DeepSeek choice
-- by moving only the current member preference to the remaining Flash model;
-- historical runs, billing records, and thread snapshots stay untouched.
UPDATE "org_members_metadata"
SET "selected_model" = 'deepseek-v4-flash',
    "updated_at" = NOW()
WHERE "selected_model" = 'deepseek-v4-pro';--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "model_providers"
    WHERE "type" IN ('deepseek-api-key', 'deepseek-codex')
  ) THEN
    RAISE EXCEPTION 'Legacy DeepSeek providers remain after migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "org_members_metadata"
    WHERE "selected_model" = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION 'Legacy DeepSeek member preferences remain after migration';
  END IF;
END;
$$;
