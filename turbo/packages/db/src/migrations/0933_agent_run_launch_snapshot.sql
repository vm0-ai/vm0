-- vm0:non-transactional
-- Add the nullable launch-history storage and install its strict v1 contract
-- without scanning or rewriting existing agent_runs rows under a catalog lock.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
DO $$
DECLARE
  v_column record;
  v_constraint_definition text;
  v_expected_constraint CONSTANT text := $constraint$CHECK (launch_snapshot IS NULL OR jsonb_typeof(launch_snapshot) = 'object'::text AND launch_snapshot ?& ARRAY['schemaVersion'::text, 'framework'::text, 'runnerProfile'::text] AND (launch_snapshot - 'schemaVersion'::text - 'framework'::text - 'runnerProfile'::text) = '{}'::jsonb AND (launch_snapshot -> 'schemaVersion'::text) = '1'::jsonb AND jsonb_typeof(launch_snapshot -> 'framework'::text) = 'string'::text AND ((launch_snapshot ->> 'framework'::text) = ANY (ARRAY['claude-code'::text, 'codex'::text, 'pi'::text])) AND jsonb_typeof(launch_snapshot -> 'runnerProfile'::text) = 'string'::text AND char_length(launch_snapshot ->> 'runnerProfile'::text) >= 1 AND char_length(launch_snapshot ->> 'runnerProfile'::text) <= 255)$constraint$;
BEGIN
  SELECT
    "column_row"."udt_name",
    "column_row"."is_nullable",
    "column_row"."column_default"
  INTO v_column
  FROM "information_schema"."columns" AS "column_row"
  WHERE "column_row"."table_schema" = 'public'
    AND "column_row"."table_name" = 'agent_runs'
    AND "column_row"."column_name" = 'launch_snapshot';

  IF NOT FOUND THEN
    ALTER TABLE "agent_runs"
    ADD COLUMN "launch_snapshot" jsonb;
  ELSIF ROW(
    v_column.udt_name,
    v_column.is_nullable,
    v_column.column_default
  ) IS DISTINCT FROM ROW('jsonb', 'YES', NULL) THEN
    RAISE EXCEPTION
      'agent_runs.launch_snapshot has a conflicting definition';
  END IF;

  SELECT pg_get_constraintdef("constraint_row"."oid", true)
  INTO v_constraint_definition
  FROM "pg_constraint" AS "constraint_row"
  WHERE "constraint_row"."conrelid" = 'public.agent_runs'::regclass
    AND "constraint_row"."conname" = 'agent_runs_launch_snapshot_check';

  IF FOUND THEN
    IF regexp_replace(
      v_constraint_definition,
      ' NOT VALID$',
      ''
    ) IS DISTINCT FROM v_expected_constraint THEN
      RAISE EXCEPTION
        'agent_runs_launch_snapshot_check has a conflicting definition: %',
        v_constraint_definition;
    END IF;
  ELSE
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I %s NOT VALID',
      'public',
      'agent_runs',
      'agent_runs_launch_snapshot_check',
      v_expected_constraint
    );
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- VALIDATE takes a ShareUpdateExclusiveLock, which remains compatible with
-- ordinary INSERT, UPDATE, and DELETE traffic while PostgreSQL scans old rows.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
ALTER TABLE "agent_runs"
VALIDATE CONSTRAINT "agent_runs_launch_snapshot_check";
--> statement-breakpoint
COMMIT;
