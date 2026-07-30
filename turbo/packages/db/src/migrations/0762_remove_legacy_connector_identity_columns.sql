-- This migration performs catalog-only DDL. PostgreSQL still needs brief
-- metadata locks, so fail instead of queueing behind production traffic.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Acquire every ACCESS EXCLUSIVE lock in the same order as migration 0738
-- before changing any object, avoiding cross-table lock-order deadlocks.
LOCK TABLE
  "connector_external_code_sessions",
  "connector_oauth_device_authorization_sessions",
  "connector_oauth_states",
  "connectors",
  "user_connectors",
  "user_permission_grants"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DROP TRIGGER "sync_connector_external_code_sessions_connector_slug" ON "connector_external_code_sessions";--> statement-breakpoint
DROP TRIGGER "sync_connector_oauth_device_sessions_connector_slug" ON "connector_oauth_device_authorization_sessions";--> statement-breakpoint
DROP TRIGGER "sync_connector_oauth_states_connector_slug" ON "connector_oauth_states";--> statement-breakpoint
DROP TRIGGER "sync_connectors_connector_slug" ON "connectors";--> statement-breakpoint
DROP TRIGGER "sync_user_connectors_connector_slug" ON "user_connectors";--> statement-breakpoint
DROP TRIGGER "sync_user_permission_grants_connector_slug" ON "user_permission_grants";--> statement-breakpoint

ALTER TABLE "connector_external_code_sessions" DROP CONSTRAINT "chk_connector_external_code_sessions_slug_matches_type";--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" DROP CONSTRAINT "chk_connector_oauth_device_sessions_slug_matches_type";--> statement-breakpoint
ALTER TABLE "connector_oauth_states" DROP CONSTRAINT "chk_connector_oauth_states_slug_matches_type";--> statement-breakpoint
ALTER TABLE "connector_oauth_states" DROP CONSTRAINT "chk_connector_oauth_states_identity";--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT "chk_connectors_connector_slug_matches_type";--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT "chk_connectors_identity";--> statement-breakpoint
ALTER TABLE "user_connectors" DROP CONSTRAINT "chk_user_connectors_slug_matches_type";--> statement-breakpoint
ALTER TABLE "user_permission_grants" DROP CONSTRAINT "chk_user_permission_grants_slug_matches_ref";--> statement-breakpoint

ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "chk_connector_oauth_states_identity" CHECK (num_nonnulls("connector_slug", "custom_connector_id") = 1);--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "chk_connectors_identity" CHECK (num_nonnulls("connector_slug", "custom_connector_id") = 1);--> statement-breakpoint

DROP INDEX "idx_connector_external_code_sessions_owner_status";--> statement-breakpoint
DROP INDEX "idx_connector_oauth_device_authorization_sessions_owner_status";--> statement-breakpoint
DROP INDEX "idx_connectors_org_user_type";--> statement-breakpoint
DROP INDEX "idx_user_connectors_unique";--> statement-breakpoint
DROP INDEX "uq_user_permission_grants_grant";--> statement-breakpoint

-- PostgreSQL drops table-local indexes and constraints with their column even
-- without CASCADE. Verify that every such dependency was named above so a
-- production-only catalog drift cannot disappear silently.
DO $$
DECLARE
  unexpected_dependencies text;
BEGIN
  WITH legacy_columns("table_name", "column_name") AS (
    VALUES
      ('connector_external_code_sessions', 'connector_type'),
      ('connector_oauth_device_authorization_sessions', 'connector_type'),
      ('connector_oauth_states', 'type'),
      ('connectors', 'type'),
      ('user_connectors', 'connector_type'),
      ('user_permission_grants', 'connector_ref')
  ),
  dependencies AS (
    SELECT
      'constraint ' || quote_ident("constraint_object"."conname")
        || ' on ' || quote_ident("legacy_columns"."table_name") AS "name"
    FROM legacy_columns
    JOIN "pg_catalog"."pg_class" AS "table_object"
      ON "table_object"."relname" = "legacy_columns"."table_name"
    JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_object"."relnamespace"
      AND "table_namespace"."nspname" = current_schema()
    JOIN "pg_catalog"."pg_attribute" AS "column_object"
      ON "column_object"."attrelid" = "table_object"."oid"
      AND "column_object"."attname" = "legacy_columns"."column_name"
      AND NOT "column_object"."attisdropped"
    JOIN "pg_catalog"."pg_constraint" AS "constraint_object"
      ON "constraint_object"."conrelid" = "table_object"."oid"
      AND "column_object"."attnum" = ANY("constraint_object"."conkey")

    UNION ALL

    SELECT
      'index ' || quote_ident("index_object"."relname")
        || ' on ' || quote_ident("legacy_columns"."table_name") AS "name"
    FROM legacy_columns
    JOIN "pg_catalog"."pg_class" AS "table_object"
      ON "table_object"."relname" = "legacy_columns"."table_name"
    JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_object"."relnamespace"
      AND "table_namespace"."nspname" = current_schema()
    JOIN "pg_catalog"."pg_attribute" AS "column_object"
      ON "column_object"."attrelid" = "table_object"."oid"
      AND "column_object"."attname" = "legacy_columns"."column_name"
      AND NOT "column_object"."attisdropped"
    JOIN "pg_catalog"."pg_index" AS "index_metadata"
      ON "index_metadata"."indrelid" = "table_object"."oid"
    JOIN "pg_catalog"."pg_class" AS "index_object"
      ON "index_object"."oid" = "index_metadata"."indexrelid"
    JOIN "pg_catalog"."pg_depend" AS "index_dependency"
      ON "index_dependency"."classid" = 'pg_catalog.pg_class'::regclass
      AND "index_dependency"."objid" = "index_object"."oid"
      AND "index_dependency"."objsubid" = 0
      AND "index_dependency"."refclassid" = 'pg_catalog.pg_class'::regclass
      AND "index_dependency"."refobjid" = "table_object"."oid"
      AND "index_dependency"."refobjsubid" = "column_object"."attnum"
  )
  SELECT string_agg("name", ', ' ORDER BY "name")
  INTO unexpected_dependencies
  FROM dependencies;

  IF unexpected_dependencies IS NOT NULL THEN
    RAISE EXCEPTION
      'unexpected legacy connector identity dependencies: %',
      unexpected_dependencies;
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "connector_external_code_sessions" DROP COLUMN "connector_type";--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" DROP COLUMN "connector_type";--> statement-breakpoint
ALTER TABLE "connector_oauth_states" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "connectors" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "user_connectors" DROP COLUMN "connector_type";--> statement-breakpoint
ALTER TABLE "user_permission_grants" DROP COLUMN "connector_ref";--> statement-breakpoint

DROP FUNCTION "sync_connector_slug_from_connector_ref"();--> statement-breakpoint
DROP FUNCTION "sync_connector_slug_from_connector_type"();--> statement-breakpoint
DROP FUNCTION "sync_connector_slug_from_type"();
