DO $$
DECLARE
  actual_dependencies text[];
  actual_relations text[];
  actual_workflow_automation_columns text[];
  actual_workflow_automation_view_columns text[];
  actual_workflow_columns text[];
  actual_workflow_view_columns text[];
BEGIN
  SELECT array_agg(
    expected.relation_name || ':' || COALESCE(relation.relkind::text, 'missing')
    ORDER BY expected.relation_name
  )
  INTO actual_relations
  FROM (
    VALUES
      ('workflow_automations', 'v'),
      ('workflow_github_processed_events', 'v'),
      ('workflow_strapi_automations', 'v'),
      ('workflow_webhook_automations', 'v'),
      ('workflow_webhook_deliveries', 'v'),
      ('workflows', 'v'),
      ('zero_workflow_automations', 'r'),
      ('zero_workflow_github_processed_events', 'r'),
      ('zero_workflow_strapi_automations', 'r'),
      ('zero_workflow_webhook_automations', 'r'),
      ('zero_workflow_webhook_deliveries', 'r'),
      ('zero_workflows', 'r')
  ) AS expected(relation_name, relation_kind)
  LEFT JOIN pg_class AS relation
    ON relation.relname = expected.relation_name
    AND relation.relnamespace = 'public'::regnamespace;

  IF actual_relations IS DISTINCT FROM ARRAY[
    'workflow_automations:v',
    'workflow_github_processed_events:v',
    'workflow_strapi_automations:v',
    'workflow_webhook_automations:v',
    'workflow_webhook_deliveries:v',
    'workflows:v',
    'zero_workflow_automations:r',
    'zero_workflow_github_processed_events:r',
    'zero_workflow_strapi_automations:r',
    'zero_workflow_webhook_automations:r',
    'zero_workflow_webhook_deliveries:r',
    'zero_workflows:r'
  ]::text[] THEN
    RAISE EXCEPTION 'workflow compatibility relation identity mismatch: %', actual_relations;
  END IF;

  SELECT array_agg(
    attribute.attname || ':' || format_type(attribute.atttypid, attribute.atttypmod)
    ORDER BY attribute.attnum
  )
  INTO actual_workflow_view_columns
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.workflows'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_workflow_view_columns IS DISTINCT FROM ARRAY[
    'id:uuid',
    'org_id:text',
    'agent_id:uuid',
    'name:character varying(64)',
    'visibility:character varying(16)',
    'instruction:text',
    'owner_user_id:text',
    'display_name:character varying(256)',
    'description:text',
    'created_by:text',
    'updated_by:text',
    'created_at:timestamp without time zone',
    'updated_at:timestamp without time zone'
  ]::text[] THEN
    RAISE EXCEPTION 'workflows compatibility view shape mismatch: %', actual_workflow_view_columns;
  END IF;

  SELECT array_agg(
    attribute.attname || ':' || format_type(attribute.atttypid, attribute.atttypmod)
    ORDER BY attribute.attnum
  )
  INTO actual_workflow_automation_view_columns
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.workflow_automations'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_workflow_automation_view_columns IS DISTINCT FROM ARRAY[
    'id:uuid',
    'org_id:text',
    'workflow_id:uuid',
    'owner_user_id:text',
    'kind:character varying(16)',
    'event_type:character varying(64)',
    'event_config:jsonb',
    'schedule_type:character varying(16)',
    'cron_expression:character varying(100)',
    'interval_seconds:integer',
    'at_time:timestamp without time zone',
    'timezone:character varying(50)',
    'enabled:boolean',
    'next_run_at:timestamp without time zone',
    'last_run_at:timestamp without time zone',
    'last_run_id:uuid',
    'consecutive_failures:integer',
    'autonomy_budget:integer',
    'created_at:timestamp without time zone',
    'updated_at:timestamp without time zone'
  ]::text[] THEN
    RAISE EXCEPTION 'workflow_automations compatibility view shape mismatch: %', actual_workflow_automation_view_columns;
  END IF;

  SELECT array_agg(
    attribute.attname || ':' || format_type(attribute.atttypid, attribute.atttypmod)
    ORDER BY attribute.attnum
  )
  INTO actual_workflow_columns
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.zero_workflows'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_workflow_columns IS DISTINCT FROM ARRAY[
    'id:uuid',
    'org_id:text',
    'name:character varying(64)',
    'display_name:character varying(256)',
    'description:text',
    'created_by:text',
    'created_at:timestamp without time zone',
    'updated_at:timestamp without time zone',
    'visibility:character varying(16)',
    'owner_user_id:text',
    'agent_id:uuid',
    'instruction:text',
    'updated_by:text',
    'official_definition_name:character varying(64)',
    'official_installation_state:character varying(32)'
  ]::text[] THEN
    RAISE EXCEPTION 'zero_workflows physical table shape mismatch: %', actual_workflow_columns;
  END IF;

  SELECT array_agg(
    attribute.attname || ':' || format_type(attribute.atttypid, attribute.atttypmod)
    ORDER BY attribute.attnum
  )
  INTO actual_workflow_automation_columns
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.zero_workflow_automations'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_workflow_automation_columns IS DISTINCT FROM ARRAY[
    'id:uuid',
    'org_id:text',
    'workflow_id:uuid',
    'owner_user_id:text',
    'schedule_type:character varying(16)',
    'cron_expression:character varying(100)',
    'interval_seconds:integer',
    'at_time:timestamp without time zone',
    'timezone:character varying(50)',
    'enabled:boolean',
    'next_run_at:timestamp without time zone',
    'last_run_at:timestamp without time zone',
    'last_run_id:uuid',
    'consecutive_failures:integer',
    'created_at:timestamp without time zone',
    'updated_at:timestamp without time zone',
    'kind:character varying(16)',
    'event_type:character varying(64)',
    'event_config:jsonb',
    'autonomy_budget:integer',
    'official_blueprint_key:character varying(64)',
    'official_applied_fingerprint:character varying(64)',
    'official_reconciliation_status:character varying(32)',
    'official_parameter_bindings:jsonb',
    'official_intended_enabled:boolean',
    'official_result_email_enabled:boolean'
  ]::text[] THEN
    RAISE EXCEPTION 'zero_workflow_automations physical table shape mismatch: %', actual_workflow_automation_columns;
  END IF;

  SELECT array_agg(
    dependency.view_name || '->' || dependency.referenced_relation_name
    ORDER BY dependency.view_name, dependency.referenced_relation_name
  )
  INTO actual_dependencies
  FROM (
    SELECT DISTINCT
      view_relation.relname AS view_name,
      referenced_relation.relname AS referenced_relation_name
    FROM pg_rewrite
    INNER JOIN pg_class AS view_relation
      ON view_relation.oid = pg_rewrite.ev_class
    INNER JOIN pg_depend
      ON pg_depend.objid = pg_rewrite.oid
    INNER JOIN pg_class AS referenced_relation
      ON referenced_relation.oid = pg_depend.refobjid
    WHERE pg_rewrite.ev_class IN (
      'public.workflows'::regclass,
      'public.workflow_automations'::regclass
    )
      AND referenced_relation.relnamespace = 'public'::regnamespace
      AND referenced_relation.relkind = 'r'
  ) AS dependency;

  IF actual_dependencies IS DISTINCT FROM ARRAY[
    'workflow_automations->zero_workflow_automations',
    'workflows->zero_workflows'
  ]::text[] THEN
    RAISE EXCEPTION 'workflow compatibility dependency mismatch: %', actual_dependencies;
  END IF;

  IF (
    SELECT count(*)
    FROM information_schema.views
    WHERE table_schema = 'public'
      AND table_name IN ('workflows', 'workflow_automations')
      AND is_insertable_into = 'YES'
      AND is_updatable = 'YES'
  ) <> 2 THEN
    RAISE EXCEPTION 'workflow compatibility views are not simply auto-updatable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid IN (
      'public.workflows'::regclass,
      'public.workflow_automations'::regclass
    )
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'workflow compatibility views have unexpected user triggers';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE VIEW "workflows" AS
SELECT
  "id",
  "org_id",
  "agent_id",
  "name",
  "visibility",
  "instruction",
  "owner_user_id",
  "display_name",
  "description",
  "created_by",
  "updated_by",
  "created_at",
  "updated_at",
  "official_definition_name",
  "official_installation_state"
FROM "zero_workflows";
--> statement-breakpoint
CREATE OR REPLACE VIEW "workflow_automations" AS
SELECT
  "id",
  "org_id",
  "workflow_id",
  "owner_user_id",
  "kind",
  "event_type",
  "event_config",
  "schedule_type",
  "cron_expression",
  "interval_seconds",
  "at_time",
  "timezone",
  "enabled",
  "next_run_at",
  "last_run_at",
  "last_run_id",
  "consecutive_failures",
  "autonomy_budget",
  "created_at",
  "updated_at",
  "official_blueprint_key",
  "official_applied_fingerprint",
  "official_reconciliation_status",
  "official_parameter_bindings",
  "official_intended_enabled",
  "official_result_email_enabled"
FROM "zero_workflow_automations";
