LOCK TABLE
  "workflows",
  "workflow_automations",
  "workflow_webhook_automations",
  "workflow_webhook_deliveries",
  "workflow_github_processed_events",
  "workflow_strapi_automations",
  "zero_workflows",
  "zero_workflow_automations",
  "zero_workflow_webhook_automations",
  "zero_workflow_webhook_deliveries",
  "zero_workflow_github_processed_events",
  "zero_workflow_strapi_automations"
IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  actual text[];
  expected text[];
BEGIN
  SELECT
    array_agg(
      expected_relation.relation_name || ':' ||
        COALESCE(actual_relation.relkind::text, 'missing')
      ORDER BY expected_relation.relation_position
    ),
    array_agg(
      expected_relation.relation_name || ':' ||
        expected_relation.relation_kind
      ORDER BY expected_relation.relation_position
    )
  INTO actual, expected
  FROM (
    VALUES
      (1, 'workflow_automations', 'v'),
      (2, 'workflow_github_processed_events', 'v'),
      (3, 'workflow_strapi_automations', 'v'),
      (4, 'workflow_webhook_automations', 'v'),
      (5, 'workflow_webhook_deliveries', 'v'),
      (6, 'workflows', 'v'),
      (7, 'zero_workflow_automations', 'r'),
      (8, 'zero_workflow_github_processed_events', 'r'),
      (9, 'zero_workflow_strapi_automations', 'r'),
      (10, 'zero_workflow_webhook_automations', 'r'),
      (11, 'zero_workflow_webhook_deliveries', 'r'),
      (12, 'zero_workflows', 'r')
  ) AS expected_relation(
    relation_position,
    relation_name,
    relation_kind
  )
  LEFT JOIN pg_class AS actual_relation
    ON actual_relation.relname = expected_relation.relation_name
    AND actual_relation.relnamespace = 'public'::regnamespace;

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch relation mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'workflows',
          'zero_workflows',
          ARRAY[
            'id',
            'org_id',
            'agent_id',
            'name',
            'visibility',
            'instruction',
            'owner_user_id',
            'display_name',
            'description',
            'created_by',
            'updated_by',
            'created_at',
            'updated_at',
            'official_definition_name',
            'official_installation_state'
          ]::text[]
        ),
        (
          'workflow_automations',
          'zero_workflow_automations',
          ARRAY[
            'id',
            'org_id',
            'workflow_id',
            'owner_user_id',
            'kind',
            'event_type',
            'event_config',
            'schedule_type',
            'cron_expression',
            'interval_seconds',
            'at_time',
            'timezone',
            'enabled',
            'next_run_at',
            'last_run_at',
            'last_run_id',
            'consecutive_failures',
            'autonomy_budget',
            'created_at',
            'updated_at',
            'official_blueprint_key',
            'official_applied_fingerprint',
            'official_reconciliation_status',
            'official_parameter_bindings',
            'official_intended_enabled',
            'official_result_email_enabled'
          ]::text[]
        ),
        (
          'workflow_webhook_automations',
          'zero_workflow_webhook_automations',
          ARRAY[
            'automation_id',
            'token_hash',
            'encrypted_token',
            'encrypted_secret',
            'secret_last_four',
            'disabled_reason',
            'last_received_at',
            'created_at',
            'updated_at'
          ]::text[]
        ),
        (
          'workflow_webhook_deliveries',
          'zero_workflow_webhook_deliveries',
          ARRAY[
            'id',
            'automation_id',
            'delivery_key',
            'body_sha256',
            'status',
            'run_id',
            'error_message',
            'received_at',
            'created_at'
          ]::text[]
        ),
        (
          'workflow_github_processed_events',
          'zero_workflow_github_processed_events',
          ARRAY[
            'id',
            'automation_id',
            'github_delivery_id',
            'repo',
            'subject_type',
            'subject_number',
            'action',
            'label_name_normalized',
            'created_at'
          ]::text[]
        ),
        (
          'workflow_strapi_automations',
          'zero_workflow_strapi_automations',
          ARRAY['automation_id', 'integration_id', 'created_at']::text[]
        )
    ) AS expected_view(canonical_name, legacy_name, column_names)
    CROSS JOIN LATERAL (
      SELECT
        array_agg(
          attribute.attname::text
          ORDER BY attribute.attnum
        ) AS column_names,
        array_agg(
          attribute.attname || ':' ||
            format_type(attribute.atttypid, attribute.atttypmod)
          ORDER BY attribute.attname::text COLLATE "C"
        ) AS typed_columns
      FROM pg_attribute AS attribute
      WHERE attribute.attrelid =
        to_regclass(format('public.%I', expected_view.canonical_name))
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) AS canonical_columns
    CROSS JOIN LATERAL (
      SELECT array_agg(
        attribute.attname || ':' ||
          format_type(attribute.atttypid, attribute.atttypmod)
        ORDER BY attribute.attname::text COLLATE "C"
      ) AS typed_columns
      FROM pg_attribute AS attribute
      WHERE attribute.attrelid =
        to_regclass(format('public.%I', expected_view.legacy_name))
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) AS legacy_columns
    WHERE canonical_columns.column_names
        IS DISTINCT FROM expected_view.column_names
      OR canonical_columns.typed_columns
        IS DISTINCT FROM legacy_columns.typed_columns
      OR cardinality(legacy_columns.typed_columns)
        IS DISTINCT FROM cardinality(expected_view.column_names)
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch compatibility columns mismatch';
  END IF;

  SELECT array_agg(
    dependency.canonical_name || '->' || dependency.legacy_name
    ORDER BY dependency.canonical_name COLLATE "C"
  )
  INTO actual
  FROM (
    SELECT DISTINCT
      view_relation.relname AS canonical_name,
      referenced_relation.relname AS legacy_name
    FROM pg_rewrite
    INNER JOIN pg_class AS view_relation
      ON view_relation.oid = pg_rewrite.ev_class
    INNER JOIN pg_depend
      ON pg_depend.objid = pg_rewrite.oid
    INNER JOIN pg_class AS referenced_relation
      ON referenced_relation.oid = pg_depend.refobjid
    WHERE view_relation.relnamespace = 'public'::regnamespace
      AND view_relation.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations'
      ]::text[])
      AND referenced_relation.relnamespace = 'public'::regnamespace
      AND referenced_relation.relkind = 'r'
  ) AS dependency;

  expected := ARRAY[
    'workflow_automations->zero_workflow_automations',
    'workflow_github_processed_events->zero_workflow_github_processed_events',
    'workflow_strapi_automations->zero_workflow_strapi_automations',
    'workflow_webhook_automations->zero_workflow_webhook_automations',
    'workflow_webhook_deliveries->zero_workflow_webhook_deliveries',
    'workflows->zero_workflows'
  ]::text[];

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch dependency mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  IF (
    SELECT count(*)
    FROM information_schema.views
    WHERE table_schema = 'public'
      AND table_name = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations'
      ]::text[])
      AND is_insertable_into = 'YES'
      AND is_updatable = 'YES'
  ) <> 6 THEN
    RAISE EXCEPTION
      'workflow physical switch canonical views are not simply writable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    INNER JOIN pg_class
      ON pg_class.oid = pg_trigger.tgrelid
    WHERE pg_class.relnamespace = 'public'::regnamespace
      AND pg_class.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations'
      ]::text[])
      AND NOT pg_trigger.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_rewrite
    INNER JOIN pg_class
      ON pg_class.oid = pg_rewrite.ev_class
    WHERE pg_class.relnamespace = 'public'::regnamespace
      AND pg_class.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations'
      ]::text[])
      AND pg_rewrite.rulename <> '_RETURN'
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch canonical views have unexpected triggers or rules';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('workflows', 'zero_workflows'),
        ('workflow_automations', 'zero_workflow_automations'),
        (
          'workflow_webhook_automations',
          'zero_workflow_webhook_automations'
        ),
        (
          'workflow_webhook_deliveries',
          'zero_workflow_webhook_deliveries'
        ),
        (
          'workflow_github_processed_events',
          'zero_workflow_github_processed_events'
        ),
        ('workflow_strapi_automations', 'zero_workflow_strapi_automations')
    ) AS relation_pair(canonical_name, legacy_name)
    INNER JOIN pg_class AS canonical_relation
      ON canonical_relation.relname = relation_pair.canonical_name
      AND canonical_relation.relnamespace = 'public'::regnamespace
    INNER JOIN pg_class AS legacy_relation
      ON legacy_relation.relname = relation_pair.legacy_name
      AND legacy_relation.relnamespace = 'public'::regnamespace
    WHERE canonical_relation.relowner <> legacy_relation.relowner
      OR NOT pg_has_role(current_user, legacy_relation.relowner, 'USAGE')
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch relation owner mismatch or inaccessible owner';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    CROSS JOIN LATERAL aclexplode(relation.relacl) AS access
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations',
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
      AND access.grantee <> relation.relowner
      AND (
        access.privilege_type NOT IN (
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE'
        )
        OR (
          access.grantee <> 0
          AND NOT EXISTS (
            SELECT 1
            FROM pg_roles
            WHERE pg_roles.oid = access.grantee
          )
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_attribute AS attribute
    INNER JOIN pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL aclexplode(attribute.attacl) AS access
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations',
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND access.grantee <> relation.relowner
      AND (
        access.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE')
        OR (
          access.grantee <> 0
          AND NOT EXISTS (
            SELECT 1
            FROM pg_roles
            WHERE pg_roles.oid = access.grantee
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch has unsupported or dangling grants';
  END IF;

  SELECT array_agg(
    index_relation.relname
    ORDER BY index_relation.relname COLLATE "C"
  )
  INTO actual
  FROM pg_index
  INNER JOIN pg_class AS index_relation
    ON index_relation.oid = pg_index.indexrelid
  INNER JOIN pg_class AS table_relation
    ON table_relation.oid = pg_index.indrelid
  LEFT JOIN pg_constraint
    ON pg_constraint.conindid = pg_index.indexrelid
  WHERE table_relation.relnamespace = 'public'::regnamespace
    AND table_relation.relname = ANY(ARRAY[
      'zero_workflows',
      'zero_workflow_automations',
      'zero_workflow_webhook_automations',
      'zero_workflow_webhook_deliveries',
      'zero_workflow_github_processed_events',
      'zero_workflow_strapi_automations'
    ]::text[])
    AND pg_constraint.oid IS NULL;

  SELECT array_agg(name ORDER BY name COLLATE "C")
  INTO expected
  FROM unnest(ARRAY[
    'idx_zero_workflow_automations_next_run',
    'idx_zero_workflow_automations_official_blueprint_unique',
    'idx_zero_workflow_automations_org',
    'idx_zero_workflow_automations_workflow',
    'idx_zero_workflow_github_processed_automation_delivery',
    'idx_zero_workflow_github_processed_subject',
    'idx_zero_workflow_strapi_automations_integration',
    'idx_zero_workflow_webhook_automations_token_hash',
    'idx_zero_workflow_webhook_deliveries_automation_key',
    'idx_zero_workflow_webhook_deliveries_automation_received',
    'idx_zero_workflows_agent',
    'idx_zero_workflows_org',
    'idx_zero_workflows_org_owner',
    'idx_zero_workflows_private_owner_agent_name_unique',
    'idx_zero_workflows_public_agent_name_unique'
  ]::text[]) AS expected_index(name);

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch index mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  SELECT array_agg(
    pg_constraint.conname
    ORDER BY pg_constraint.conname COLLATE "C"
  )
  INTO actual
  FROM pg_constraint
  INNER JOIN pg_class AS table_relation
    ON table_relation.oid = pg_constraint.conrelid
  WHERE pg_constraint.contype = 'p'
    AND table_relation.relnamespace = 'public'::regnamespace
    AND table_relation.relname = ANY(ARRAY[
      'zero_workflows',
      'zero_workflow_automations',
      'zero_workflow_webhook_automations',
      'zero_workflow_webhook_deliveries',
      'zero_workflow_github_processed_events',
      'zero_workflow_strapi_automations'
    ]::text[]);

  SELECT array_agg(name ORDER BY name COLLATE "C")
  INTO expected
  FROM unnest(ARRAY[
    'zero_workflow_automations_pkey',
    'zero_workflow_github_processed_events_pkey',
    'zero_workflow_strapi_automations_pkey',
    'zero_workflow_webhook_automations_pkey',
    'zero_workflow_webhook_deliveries_pkey',
    'zero_workflows_pkey'
  ]::text[]) AS expected_primary_key(name);

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch primary key mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  SELECT array_agg(
    pg_constraint.conname
    ORDER BY pg_constraint.conname COLLATE "C"
  )
  INTO actual
  FROM pg_constraint
  INNER JOIN pg_class AS table_relation
    ON table_relation.oid = pg_constraint.conrelid
  WHERE pg_constraint.contype = 'c'
    AND table_relation.relnamespace = 'public'::regnamespace
    AND table_relation.relname = ANY(ARRAY[
      'zero_workflows',
      'zero_workflow_automations',
      'zero_workflow_webhook_automations',
      'zero_workflow_webhook_deliveries',
      'zero_workflow_github_processed_events',
      'zero_workflow_strapi_automations'
    ]::text[]);

  SELECT array_agg(name ORDER BY name COLLATE "C")
  INTO expected
  FROM unnest(ARRAY[
    'zero_workflow_automations_autonomy_budget_check',
    'zero_workflow_automations_official_binding_check',
    'zero_workflow_automations_schedule_config_check',
    'zero_workflows_official_installation_check'
  ]::text[]) AS expected_check(name);

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch check mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  SELECT array_agg(
    pg_constraint.conname
    ORDER BY pg_constraint.conname COLLATE "C"
  )
  INTO actual
  FROM pg_constraint
  INNER JOIN pg_class AS source_relation
    ON source_relation.oid = pg_constraint.conrelid
  INNER JOIN pg_class AS referenced_relation
    ON referenced_relation.oid = pg_constraint.confrelid
  WHERE pg_constraint.contype = 'f'
    AND pg_constraint.connamespace = 'public'::regnamespace
    AND (
      source_relation.relname = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
      OR referenced_relation.relname = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
    );

  SELECT array_agg(name ORDER BY name COLLATE "C")
  INTO expected
  FROM unnest(ARRAY[
    'agent_runs_workflow_automation_id_zero_workflow_automations_id_',
    'gmail_processed_events_automation_id_zero_workflow_automations_',
    'google_calendar_processed_events_automation_id_zero_workflow_au',
    'google_forms_automation_cursors_automation_id_zero_workflow_aut',
    'google_forms_processed_events_automation_id_zero_workflow_autom',
    'google_workspace_processed_events_automation_id_zero_workflow_a',
    'notion_workflow_pending_events_automation_id_zero_workflow_auto',
    'official_workflow_automation_identity_automation_fk',
    'official_workflow_automation_identity_workflow_fk',
    'strapi_workflow_pending_events_automation_id_zero_workflow_auto',
    'stripe_workflow_automation_health_automation_id_zero_workflow_a',
    'workflow_user_automation_threads_workflow_id_zero_workflows_id_',
    'zero_workflow_automations_workflow_id_zero_workflows_id_fk',
    'zero_workflow_github_processed_events_automation_id_zero_workfl',
    'zero_workflow_strapi_automations_automation_id_zero_workflow_au',
    'zero_workflow_strapi_automations_integration_id_strapi_integrat',
    'zero_workflow_webhook_automations_automation_id_zero_workflow_a',
    'zero_workflow_webhook_deliveries_automation_id_zero_workflow_au',
    'zero_workflows_agent_id_agents_id_fk'
  ]::text[]) AS expected_foreign_key(name);

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch foreign key mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class
    WHERE pg_class.relnamespace = 'public'::regnamespace
      AND pg_class.relname = ANY(ARRAY[
        'idx_workflow_automations_next_run',
        'idx_workflow_automations_official_blueprint_unique',
        'idx_workflow_automations_org',
        'idx_workflow_automations_workflow',
        'idx_workflow_github_processed_automation_delivery',
        'idx_workflow_github_processed_subject',
        'idx_workflow_strapi_automations_integration',
        'idx_workflow_webhook_automations_token_hash',
        'idx_workflow_webhook_deliveries_automation_key',
        'idx_workflow_webhook_deliveries_automation_received',
        'idx_workflows_agent',
        'idx_workflows_org',
        'idx_workflows_org_owner',
        'idx_workflows_private_owner_agent_name_unique',
        'idx_workflows_public_agent_name_unique',
        'workflow_automations_pkey',
        'workflow_github_processed_events_pkey',
        'workflow_strapi_automations_pkey',
        'workflow_webhook_automations_pkey',
        'workflow_webhook_deliveries_pkey',
        'workflows_pkey'
      ]::text[])
  ) OR EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE pg_constraint.connamespace = 'public'::regnamespace
      AND pg_constraint.conname = ANY(ARRAY[
        'agent_runs_workflow_automation_id_workflow_automations_id_fk',
        'gmail_processed_events_automation_id_workflow_automations_id_fk',
        'google_calendar_processed_events_automation_id_workflow_automat',
        'google_forms_automation_cursors_automation_id_workflow_automati',
        'google_forms_processed_events_automation_id_workflow_automation',
        'google_workspace_processed_events_automation_id_workflow_automa',
        'notion_workflow_pending_events_automation_id_workflow_automatio',
        'strapi_workflow_pending_events_automation_id_workflow_automatio',
        'stripe_workflow_automation_health_automation_id_workflow_automa',
        'workflow_user_automation_threads_workflow_id_workflows_id_fk',
        'workflow_automations_workflow_id_workflows_id_fk',
        'workflow_github_processed_events_automation_id_workflow_automat',
        'workflow_strapi_automations_automation_id_workflow_automations_',
        'workflow_strapi_automations_integration_id_strapi_integrations_',
        'workflow_webhook_automations_automation_id_workflow_automations',
        'workflow_webhook_deliveries_automation_id_workflow_automations_',
        'workflows_agent_id_agents_id_fk',
        'workflow_automations_pkey',
        'workflow_github_processed_events_pkey',
        'workflow_strapi_automations_pkey',
        'workflow_webhook_automations_pkey',
        'workflow_webhook_deliveries_pkey',
        'workflows_pkey',
        'workflow_automations_autonomy_budget_check',
        'workflow_automations_official_binding_check',
        'workflow_automations_schedule_config_check',
        'workflows_official_installation_check'
      ]::text[])
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch target identifier collision';
  END IF;
END $$;
--> statement-breakpoint
CREATE TEMP TABLE workflow_physical_switch_relations
ON COMMIT DROP
AS
SELECT
  relation.relname AS relation_name,
  pg_get_userbyid(relation.relowner) AS owner_name
FROM pg_class AS relation
WHERE relation.relnamespace = 'public'::regnamespace
  AND relation.relname = ANY(ARRAY[
    'workflows',
    'workflow_automations',
    'workflow_webhook_automations',
    'workflow_webhook_deliveries',
    'workflow_github_processed_events',
    'workflow_strapi_automations',
    'zero_workflows',
    'zero_workflow_automations',
    'zero_workflow_webhook_automations',
    'zero_workflow_webhook_deliveries',
    'zero_workflow_github_processed_events',
    'zero_workflow_strapi_automations'
  ]::text[]);
--> statement-breakpoint
CREATE TEMP TABLE workflow_physical_switch_relation_acl
ON COMMIT DROP
AS
SELECT
  relation.relname AS relation_name,
  CASE
    WHEN access.grantee = 0 THEN NULL
    ELSE pg_get_userbyid(access.grantee)
  END AS grantee_name,
  access.privilege_type,
  access.is_grantable
FROM pg_class AS relation
CROSS JOIN LATERAL aclexplode(relation.relacl) AS access
WHERE relation.relnamespace = 'public'::regnamespace
  AND relation.relname = ANY(ARRAY[
    'workflows',
    'workflow_automations',
    'workflow_webhook_automations',
    'workflow_webhook_deliveries',
    'workflow_github_processed_events',
    'workflow_strapi_automations',
    'zero_workflows',
    'zero_workflow_automations',
    'zero_workflow_webhook_automations',
    'zero_workflow_webhook_deliveries',
    'zero_workflow_github_processed_events',
    'zero_workflow_strapi_automations'
  ]::text[])
  AND access.grantee <> relation.relowner;
--> statement-breakpoint
CREATE TEMP TABLE workflow_physical_switch_column_acl
ON COMMIT DROP
AS
SELECT
  relation.relname AS relation_name,
  attribute.attname AS column_name,
  CASE
    WHEN access.grantee = 0 THEN NULL
    ELSE pg_get_userbyid(access.grantee)
  END AS grantee_name,
  access.privilege_type,
  access.is_grantable
FROM pg_attribute AS attribute
INNER JOIN pg_class AS relation
  ON relation.oid = attribute.attrelid
CROSS JOIN LATERAL aclexplode(attribute.attacl) AS access
WHERE relation.relnamespace = 'public'::regnamespace
  AND relation.relname = ANY(ARRAY[
    'workflows',
    'workflow_automations',
    'workflow_webhook_automations',
    'workflow_webhook_deliveries',
    'workflow_github_processed_events',
    'workflow_strapi_automations',
    'zero_workflows',
    'zero_workflow_automations',
    'zero_workflow_webhook_automations',
    'zero_workflow_webhook_deliveries',
    'zero_workflow_github_processed_events',
    'zero_workflow_strapi_automations'
  ]::text[])
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND access.grantee <> relation.relowner;
--> statement-breakpoint
DROP VIEW
  "workflow_automations",
  "workflow_github_processed_events",
  "workflow_strapi_automations",
  "workflow_webhook_automations",
  "workflow_webhook_deliveries",
  "workflows";
--> statement-breakpoint
ALTER TABLE "zero_workflows" RENAME TO "workflows";
--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" RENAME TO "workflow_automations";
--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_automations"
RENAME TO "workflow_webhook_automations";
--> statement-breakpoint
ALTER TABLE "zero_workflow_webhook_deliveries"
RENAME TO "workflow_webhook_deliveries";
--> statement-breakpoint
ALTER TABLE "zero_workflow_github_processed_events"
RENAME TO "workflow_github_processed_events";
--> statement-breakpoint
ALTER TABLE "zero_workflow_strapi_automations"
RENAME TO "workflow_strapi_automations";
--> statement-breakpoint
ALTER TABLE "workflow_automations"
RENAME CONSTRAINT "zero_workflow_automations_pkey"
TO "workflow_automations_pkey";
--> statement-breakpoint
ALTER TABLE "workflow_github_processed_events"
RENAME CONSTRAINT "zero_workflow_github_processed_events_pkey"
TO "workflow_github_processed_events_pkey";
--> statement-breakpoint
ALTER TABLE "workflow_strapi_automations"
RENAME CONSTRAINT "zero_workflow_strapi_automations_pkey"
TO "workflow_strapi_automations_pkey";
--> statement-breakpoint
ALTER TABLE "workflow_webhook_automations"
RENAME CONSTRAINT "zero_workflow_webhook_automations_pkey"
TO "workflow_webhook_automations_pkey";
--> statement-breakpoint
ALTER TABLE "workflow_webhook_deliveries"
RENAME CONSTRAINT "zero_workflow_webhook_deliveries_pkey"
TO "workflow_webhook_deliveries_pkey";
--> statement-breakpoint
ALTER TABLE "workflows"
RENAME CONSTRAINT "zero_workflows_pkey"
TO "workflows_pkey";
--> statement-breakpoint
ALTER TABLE "workflow_automations"
RENAME CONSTRAINT "zero_workflow_automations_autonomy_budget_check"
TO "workflow_automations_autonomy_budget_check";
--> statement-breakpoint
ALTER TABLE "workflow_automations"
RENAME CONSTRAINT "zero_workflow_automations_official_binding_check"
TO "workflow_automations_official_binding_check";
--> statement-breakpoint
ALTER TABLE "workflow_automations"
RENAME CONSTRAINT "zero_workflow_automations_schedule_config_check"
TO "workflow_automations_schedule_config_check";
--> statement-breakpoint
ALTER TABLE "workflows"
RENAME CONSTRAINT "zero_workflows_official_installation_check"
TO "workflows_official_installation_check";
--> statement-breakpoint
ALTER TABLE "agent_runs"
RENAME CONSTRAINT "agent_runs_workflow_automation_id_zero_workflow_automations_id_"
TO "agent_runs_workflow_automation_id_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "gmail_processed_events"
RENAME CONSTRAINT "gmail_processed_events_automation_id_zero_workflow_automations_"
TO "gmail_processed_events_automation_id_workflow_automations_id_fk";
--> statement-breakpoint
ALTER TABLE "google_calendar_processed_events"
RENAME CONSTRAINT "google_calendar_processed_events_automation_id_zero_workflow_au"
TO "google_calendar_processed_events_automation_id_workflow_automat";
--> statement-breakpoint
ALTER TABLE "google_forms_automation_cursors"
RENAME CONSTRAINT "google_forms_automation_cursors_automation_id_zero_workflow_aut"
TO "google_forms_automation_cursors_automation_id_workflow_automati";
--> statement-breakpoint
ALTER TABLE "google_forms_processed_events"
RENAME CONSTRAINT "google_forms_processed_events_automation_id_zero_workflow_autom"
TO "google_forms_processed_events_automation_id_workflow_automation";
--> statement-breakpoint
ALTER TABLE "google_workspace_processed_events"
RENAME CONSTRAINT "google_workspace_processed_events_automation_id_zero_workflow_a"
TO "google_workspace_processed_events_automation_id_workflow_automa";
--> statement-breakpoint
ALTER TABLE "notion_workflow_pending_events"
RENAME CONSTRAINT "notion_workflow_pending_events_automation_id_zero_workflow_auto"
TO "notion_workflow_pending_events_automation_id_workflow_automatio";
--> statement-breakpoint
ALTER TABLE "strapi_workflow_pending_events"
RENAME CONSTRAINT "strapi_workflow_pending_events_automation_id_zero_workflow_auto"
TO "strapi_workflow_pending_events_automation_id_workflow_automatio";
--> statement-breakpoint
ALTER TABLE "stripe_workflow_automation_health"
RENAME CONSTRAINT "stripe_workflow_automation_health_automation_id_zero_workflow_a"
TO "stripe_workflow_automation_health_automation_id_workflow_automa";
--> statement-breakpoint
ALTER TABLE "workflow_user_automation_threads"
RENAME CONSTRAINT "workflow_user_automation_threads_workflow_id_zero_workflows_id_"
TO "workflow_user_automation_threads_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_automations"
RENAME CONSTRAINT "zero_workflow_automations_workflow_id_zero_workflows_id_fk"
TO "workflow_automations_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_github_processed_events"
RENAME CONSTRAINT "zero_workflow_github_processed_events_automation_id_zero_workfl"
TO "workflow_github_processed_events_automation_id_workflow_automat";
--> statement-breakpoint
ALTER TABLE "workflow_strapi_automations"
RENAME CONSTRAINT "zero_workflow_strapi_automations_automation_id_zero_workflow_au"
TO "workflow_strapi_automations_automation_id_workflow_automations_";
--> statement-breakpoint
ALTER TABLE "workflow_strapi_automations"
RENAME CONSTRAINT "zero_workflow_strapi_automations_integration_id_strapi_integrat"
TO "workflow_strapi_automations_integration_id_strapi_integrations_";
--> statement-breakpoint
ALTER TABLE "workflow_webhook_automations"
RENAME CONSTRAINT "zero_workflow_webhook_automations_automation_id_zero_workflow_a"
TO "workflow_webhook_automations_automation_id_workflow_automations";
--> statement-breakpoint
ALTER TABLE "workflow_webhook_deliveries"
RENAME CONSTRAINT "zero_workflow_webhook_deliveries_automation_id_zero_workflow_au"
TO "workflow_webhook_deliveries_automation_id_workflow_automations_";
--> statement-breakpoint
ALTER TABLE "workflows"
RENAME CONSTRAINT "zero_workflows_agent_id_agents_id_fk"
TO "workflows_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_automations_next_run"
RENAME TO "idx_workflow_automations_next_run";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_automations_official_blueprint_unique"
RENAME TO "idx_workflow_automations_official_blueprint_unique";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_automations_org"
RENAME TO "idx_workflow_automations_org";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_automations_workflow"
RENAME TO "idx_workflow_automations_workflow";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_github_processed_automation_delivery"
RENAME TO "idx_workflow_github_processed_automation_delivery";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_github_processed_subject"
RENAME TO "idx_workflow_github_processed_subject";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_strapi_automations_integration"
RENAME TO "idx_workflow_strapi_automations_integration";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_webhook_automations_token_hash"
RENAME TO "idx_workflow_webhook_automations_token_hash";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_webhook_deliveries_automation_key"
RENAME TO "idx_workflow_webhook_deliveries_automation_key";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflow_webhook_deliveries_automation_received"
RENAME TO "idx_workflow_webhook_deliveries_automation_received";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflows_agent"
RENAME TO "idx_workflows_agent";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflows_org"
RENAME TO "idx_workflows_org";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflows_org_owner"
RENAME TO "idx_workflows_org_owner";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflows_private_owner_agent_name_unique"
RENAME TO "idx_workflows_private_owner_agent_name_unique";
--> statement-breakpoint
ALTER INDEX "idx_zero_workflows_public_agent_name_unique"
RENAME TO "idx_workflows_public_agent_name_unique";
--> statement-breakpoint
CREATE VIEW "zero_workflows" AS
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
FROM "workflows";
--> statement-breakpoint
CREATE VIEW "zero_workflow_automations" AS
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
FROM "workflow_automations";
--> statement-breakpoint
CREATE VIEW "zero_workflow_webhook_automations" AS
SELECT
  "automation_id",
  "token_hash",
  "encrypted_token",
  "encrypted_secret",
  "secret_last_four",
  "disabled_reason",
  "last_received_at",
  "created_at",
  "updated_at"
FROM "workflow_webhook_automations";
--> statement-breakpoint
CREATE VIEW "zero_workflow_webhook_deliveries" AS
SELECT
  "id",
  "automation_id",
  "delivery_key",
  "body_sha256",
  "status",
  "run_id",
  "error_message",
  "received_at",
  "created_at"
FROM "workflow_webhook_deliveries";
--> statement-breakpoint
CREATE VIEW "zero_workflow_github_processed_events" AS
SELECT
  "id",
  "automation_id",
  "github_delivery_id",
  "repo",
  "subject_type",
  "subject_number",
  "action",
  "label_name_normalized",
  "created_at"
FROM "workflow_github_processed_events";
--> statement-breakpoint
CREATE VIEW "zero_workflow_strapi_automations" AS
SELECT
  "automation_id",
  "integration_id",
  "created_at"
FROM "workflow_strapi_automations";
--> statement-breakpoint
DO $$
DECLARE
  access record;
  role_sql text;
BEGIN
  FOR access IN
    SELECT relation_name, owner_name
    FROM workflow_physical_switch_relations
    WHERE relation_name LIKE 'zero_workflow%'
    ORDER BY relation_name COLLATE "C"
  LOOP
    EXECUTE format(
      'ALTER VIEW %I OWNER TO %I',
      access.relation_name,
      access.owner_name
    );
  END LOOP;

  FOR access IN
    SELECT DISTINCT
      relation.relname AS relation_name,
      CASE
        WHEN exploded.grantee = 0 THEN NULL
        ELSE pg_get_userbyid(exploded.grantee)
      END AS grantee_name
    FROM pg_class AS relation
    CROSS JOIN LATERAL aclexplode(relation.relacl) AS exploded
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations',
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
      AND exploded.grantee <> relation.relowner
  LOOP
    role_sql := CASE
      WHEN access.grantee_name IS NULL THEN 'PUBLIC'
      ELSE format('%I', access.grantee_name)
    END;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I FROM %s',
      access.relation_name,
      role_sql
    );
  END LOOP;

  FOR access IN
    SELECT DISTINCT
      relation.relname AS relation_name,
      attribute.attname AS column_name,
      CASE
        WHEN exploded.grantee = 0 THEN NULL
        ELSE pg_get_userbyid(exploded.grantee)
      END AS grantee_name
    FROM pg_attribute AS attribute
    INNER JOIN pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL aclexplode(attribute.attacl) AS exploded
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations',
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND exploded.grantee <> relation.relowner
  LOOP
    role_sql := CASE
      WHEN access.grantee_name IS NULL THEN 'PUBLIC'
      ELSE format('%I', access.grantee_name)
    END;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE %I FROM %s',
      access.column_name,
      access.relation_name,
      role_sql
    );
  END LOOP;

  FOR access IN
    SELECT
      relation_name,
      grantee_name,
      is_grantable,
      string_agg(
        privilege_type,
        ', '
        ORDER BY privilege_type COLLATE "C"
      ) AS privileges
    FROM workflow_physical_switch_relation_acl
    GROUP BY relation_name, grantee_name, is_grantable
    ORDER BY relation_name COLLATE "C", grantee_name COLLATE "C" NULLS FIRST
  LOOP
    role_sql := CASE
      WHEN access.grantee_name IS NULL THEN 'PUBLIC'
      ELSE format('%I', access.grantee_name)
    END;
    EXECUTE format(
      'GRANT %s ON TABLE %I TO %s%s',
      access.privileges,
      access.relation_name,
      role_sql,
      CASE WHEN access.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    );
  END LOOP;

  FOR access IN
    SELECT
      relation_name,
      column_name,
      grantee_name,
      is_grantable,
      string_agg(
        privilege_type,
        ', '
        ORDER BY privilege_type COLLATE "C"
      ) AS privileges
    FROM workflow_physical_switch_column_acl
    GROUP BY
      relation_name,
      column_name,
      grantee_name,
      is_grantable
    ORDER BY
      relation_name COLLATE "C",
      column_name COLLATE "C",
      grantee_name COLLATE "C" NULLS FIRST
  LOOP
    role_sql := CASE
      WHEN access.grantee_name IS NULL THEN 'PUBLIC'
      ELSE format('%I', access.grantee_name)
    END;
    EXECUTE format(
      'GRANT %s (%I) ON TABLE %I TO %s%s',
      access.privileges,
      access.column_name,
      access.relation_name,
      role_sql,
      CASE WHEN access.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    );
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  actual text[];
  expected text[];
BEGIN
  SELECT
    array_agg(
      expected_relation.relation_name || ':' ||
        COALESCE(actual_relation.relkind::text, 'missing')
      ORDER BY expected_relation.relation_position
    ),
    array_agg(
      expected_relation.relation_name || ':' ||
        expected_relation.relation_kind
      ORDER BY expected_relation.relation_position
    )
  INTO actual, expected
  FROM (
    VALUES
      (1, 'workflow_automations', 'r'),
      (2, 'workflow_github_processed_events', 'r'),
      (3, 'workflow_strapi_automations', 'r'),
      (4, 'workflow_webhook_automations', 'r'),
      (5, 'workflow_webhook_deliveries', 'r'),
      (6, 'workflows', 'r'),
      (7, 'zero_workflow_automations', 'v'),
      (8, 'zero_workflow_github_processed_events', 'v'),
      (9, 'zero_workflow_strapi_automations', 'v'),
      (10, 'zero_workflow_webhook_automations', 'v'),
      (11, 'zero_workflow_webhook_deliveries', 'v'),
      (12, 'zero_workflows', 'v')
  ) AS expected_relation(
    relation_position,
    relation_name,
    relation_kind
  )
  LEFT JOIN pg_class AS actual_relation
    ON actual_relation.relname = expected_relation.relation_name
    AND actual_relation.relnamespace = 'public'::regnamespace;

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition relation mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'workflows',
          'zero_workflows',
          ARRAY[
            'id',
            'org_id',
            'agent_id',
            'name',
            'visibility',
            'instruction',
            'owner_user_id',
            'display_name',
            'description',
            'created_by',
            'updated_by',
            'created_at',
            'updated_at',
            'official_definition_name',
            'official_installation_state'
          ]::text[]
        ),
        (
          'workflow_automations',
          'zero_workflow_automations',
          ARRAY[
            'id',
            'org_id',
            'workflow_id',
            'owner_user_id',
            'kind',
            'event_type',
            'event_config',
            'schedule_type',
            'cron_expression',
            'interval_seconds',
            'at_time',
            'timezone',
            'enabled',
            'next_run_at',
            'last_run_at',
            'last_run_id',
            'consecutive_failures',
            'autonomy_budget',
            'created_at',
            'updated_at',
            'official_blueprint_key',
            'official_applied_fingerprint',
            'official_reconciliation_status',
            'official_parameter_bindings',
            'official_intended_enabled',
            'official_result_email_enabled'
          ]::text[]
        ),
        (
          'workflow_webhook_automations',
          'zero_workflow_webhook_automations',
          ARRAY[
            'automation_id',
            'token_hash',
            'encrypted_token',
            'encrypted_secret',
            'secret_last_four',
            'disabled_reason',
            'last_received_at',
            'created_at',
            'updated_at'
          ]::text[]
        ),
        (
          'workflow_webhook_deliveries',
          'zero_workflow_webhook_deliveries',
          ARRAY[
            'id',
            'automation_id',
            'delivery_key',
            'body_sha256',
            'status',
            'run_id',
            'error_message',
            'received_at',
            'created_at'
          ]::text[]
        ),
        (
          'workflow_github_processed_events',
          'zero_workflow_github_processed_events',
          ARRAY[
            'id',
            'automation_id',
            'github_delivery_id',
            'repo',
            'subject_type',
            'subject_number',
            'action',
            'label_name_normalized',
            'created_at'
          ]::text[]
        ),
        (
          'workflow_strapi_automations',
          'zero_workflow_strapi_automations',
          ARRAY['automation_id', 'integration_id', 'created_at']::text[]
        )
    ) AS expected_view(canonical_name, legacy_name, column_names)
    CROSS JOIN LATERAL (
      SELECT array_agg(
        attribute.attname || ':' ||
          format_type(attribute.atttypid, attribute.atttypmod)
        ORDER BY attribute.attname::text COLLATE "C"
      ) AS typed_columns
      FROM pg_attribute AS attribute
      WHERE attribute.attrelid =
        to_regclass(format('public.%I', expected_view.canonical_name))
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) AS canonical_columns
    CROSS JOIN LATERAL (
      SELECT
        array_agg(
          attribute.attname::text
          ORDER BY attribute.attnum
        ) AS column_names,
        array_agg(
          attribute.attname || ':' ||
            format_type(attribute.atttypid, attribute.atttypmod)
          ORDER BY attribute.attname::text COLLATE "C"
        ) AS typed_columns
      FROM pg_attribute AS attribute
      WHERE attribute.attrelid =
        to_regclass(format('public.%I', expected_view.legacy_name))
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) AS legacy_columns
    WHERE legacy_columns.column_names
        IS DISTINCT FROM expected_view.column_names
      OR canonical_columns.typed_columns
        IS DISTINCT FROM legacy_columns.typed_columns
      OR cardinality(canonical_columns.typed_columns)
        IS DISTINCT FROM cardinality(expected_view.column_names)
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition columns mismatch';
  END IF;

  SELECT array_agg(
    dependency.legacy_name || '->' || dependency.canonical_name
    ORDER BY dependency.legacy_name COLLATE "C"
  )
  INTO actual
  FROM (
    SELECT DISTINCT
      view_relation.relname AS legacy_name,
      referenced_relation.relname AS canonical_name
    FROM pg_rewrite
    INNER JOIN pg_class AS view_relation
      ON view_relation.oid = pg_rewrite.ev_class
    INNER JOIN pg_depend
      ON pg_depend.objid = pg_rewrite.oid
    INNER JOIN pg_class AS referenced_relation
      ON referenced_relation.oid = pg_depend.refobjid
    WHERE view_relation.relnamespace = 'public'::regnamespace
      AND view_relation.relname = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
      AND referenced_relation.relnamespace = 'public'::regnamespace
      AND referenced_relation.relkind = 'r'
  ) AS dependency;

  expected := ARRAY[
    'zero_workflow_automations->workflow_automations',
    'zero_workflow_github_processed_events->workflow_github_processed_events',
    'zero_workflow_strapi_automations->workflow_strapi_automations',
    'zero_workflow_webhook_automations->workflow_webhook_automations',
    'zero_workflow_webhook_deliveries->workflow_webhook_deliveries',
    'zero_workflows->workflows'
  ]::text[];

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition dependency mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  IF (
    SELECT count(*)
    FROM information_schema.views
    WHERE table_schema = 'public'
      AND table_name = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
      AND is_insertable_into = 'YES'
      AND is_updatable = 'YES'
  ) <> 6 THEN
    RAISE EXCEPTION
      'workflow physical switch legacy views are not simply writable';
  END IF;

  SELECT array_agg(
    index_relation.relname
    ORDER BY index_relation.relname COLLATE "C"
  )
  INTO actual
  FROM pg_index
  INNER JOIN pg_class AS index_relation
    ON index_relation.oid = pg_index.indexrelid
  INNER JOIN pg_class AS table_relation
    ON table_relation.oid = pg_index.indrelid
  LEFT JOIN pg_constraint
    ON pg_constraint.conindid = pg_index.indexrelid
  WHERE table_relation.relnamespace = 'public'::regnamespace
    AND table_relation.relname = ANY(ARRAY[
      'workflows',
      'workflow_automations',
      'workflow_webhook_automations',
      'workflow_webhook_deliveries',
      'workflow_github_processed_events',
      'workflow_strapi_automations'
    ]::text[])
    AND pg_constraint.oid IS NULL;

  SELECT array_agg(name ORDER BY name COLLATE "C")
  INTO expected
  FROM unnest(ARRAY[
    'idx_workflow_automations_next_run',
    'idx_workflow_automations_official_blueprint_unique',
    'idx_workflow_automations_org',
    'idx_workflow_automations_workflow',
    'idx_workflow_github_processed_automation_delivery',
    'idx_workflow_github_processed_subject',
    'idx_workflow_strapi_automations_integration',
    'idx_workflow_webhook_automations_token_hash',
    'idx_workflow_webhook_deliveries_automation_key',
    'idx_workflow_webhook_deliveries_automation_received',
    'idx_workflows_agent',
    'idx_workflows_org',
    'idx_workflows_org_owner',
    'idx_workflows_private_owner_agent_name_unique',
    'idx_workflows_public_agent_name_unique'
  ]::text[]) AS expected_index(name);

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition index mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  SELECT array_agg(
    pg_constraint.conname
    ORDER BY pg_constraint.conname COLLATE "C"
  )
  INTO actual
  FROM pg_constraint
  INNER JOIN pg_class AS table_relation
    ON table_relation.oid = pg_constraint.conrelid
  WHERE pg_constraint.contype = 'p'
    AND table_relation.relnamespace = 'public'::regnamespace
    AND table_relation.relname = ANY(ARRAY[
      'workflows',
      'workflow_automations',
      'workflow_webhook_automations',
      'workflow_webhook_deliveries',
      'workflow_github_processed_events',
      'workflow_strapi_automations'
    ]::text[]);

  SELECT array_agg(name ORDER BY name COLLATE "C")
  INTO expected
  FROM unnest(ARRAY[
    'workflow_automations_pkey',
    'workflow_github_processed_events_pkey',
    'workflow_strapi_automations_pkey',
    'workflow_webhook_automations_pkey',
    'workflow_webhook_deliveries_pkey',
    'workflows_pkey'
  ]::text[]) AS expected_primary_key(name);

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition primary key mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  SELECT array_agg(
    pg_constraint.conname
    ORDER BY pg_constraint.conname COLLATE "C"
  )
  INTO actual
  FROM pg_constraint
  INNER JOIN pg_class AS table_relation
    ON table_relation.oid = pg_constraint.conrelid
  WHERE pg_constraint.contype = 'c'
    AND table_relation.relnamespace = 'public'::regnamespace
    AND table_relation.relname = ANY(ARRAY[
      'workflows',
      'workflow_automations',
      'workflow_webhook_automations',
      'workflow_webhook_deliveries',
      'workflow_github_processed_events',
      'workflow_strapi_automations'
    ]::text[]);

  SELECT array_agg(name ORDER BY name COLLATE "C")
  INTO expected
  FROM unnest(ARRAY[
    'workflow_automations_autonomy_budget_check',
    'workflow_automations_official_binding_check',
    'workflow_automations_schedule_config_check',
    'workflows_official_installation_check'
  ]::text[]) AS expected_check(name);

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition check mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  SELECT array_agg(
    pg_constraint.conname
    ORDER BY pg_constraint.conname COLLATE "C"
  )
  INTO actual
  FROM pg_constraint
  INNER JOIN pg_class AS source_relation
    ON source_relation.oid = pg_constraint.conrelid
  INNER JOIN pg_class AS referenced_relation
    ON referenced_relation.oid = pg_constraint.confrelid
  WHERE pg_constraint.contype = 'f'
    AND pg_constraint.connamespace = 'public'::regnamespace
    AND (
      source_relation.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations'
      ]::text[])
      OR referenced_relation.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations'
      ]::text[])
    );

  SELECT array_agg(name ORDER BY name COLLATE "C")
  INTO expected
  FROM unnest(ARRAY[
    'agent_runs_workflow_automation_id_workflow_automations_id_fk',
    'gmail_processed_events_automation_id_workflow_automations_id_fk',
    'google_calendar_processed_events_automation_id_workflow_automat',
    'google_forms_automation_cursors_automation_id_workflow_automati',
    'google_forms_processed_events_automation_id_workflow_automation',
    'google_workspace_processed_events_automation_id_workflow_automa',
    'notion_workflow_pending_events_automation_id_workflow_automatio',
    'official_workflow_automation_identity_automation_fk',
    'official_workflow_automation_identity_workflow_fk',
    'strapi_workflow_pending_events_automation_id_workflow_automatio',
    'stripe_workflow_automation_health_automation_id_workflow_automa',
    'workflow_user_automation_threads_workflow_id_workflows_id_fk',
    'workflow_automations_workflow_id_workflows_id_fk',
    'workflow_github_processed_events_automation_id_workflow_automat',
    'workflow_strapi_automations_automation_id_workflow_automations_',
    'workflow_strapi_automations_integration_id_strapi_integrations_',
    'workflow_webhook_automations_automation_id_workflow_automations',
    'workflow_webhook_deliveries_automation_id_workflow_automations_',
    'workflows_agent_id_agents_id_fk'
  ]::text[]) AS expected_foreign_key(name);

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition foreign key mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class
    WHERE pg_class.relnamespace = 'public'::regnamespace
      AND pg_class.relname = ANY(ARRAY[
        'idx_zero_workflow_automations_next_run',
        'idx_zero_workflow_automations_official_blueprint_unique',
        'idx_zero_workflow_automations_org',
        'idx_zero_workflow_automations_workflow',
        'idx_zero_workflow_github_processed_automation_delivery',
        'idx_zero_workflow_github_processed_subject',
        'idx_zero_workflow_strapi_automations_integration',
        'idx_zero_workflow_webhook_automations_token_hash',
        'idx_zero_workflow_webhook_deliveries_automation_key',
        'idx_zero_workflow_webhook_deliveries_automation_received',
        'idx_zero_workflows_agent',
        'idx_zero_workflows_org',
        'idx_zero_workflows_org_owner',
        'idx_zero_workflows_private_owner_agent_name_unique',
        'idx_zero_workflows_public_agent_name_unique',
        'zero_workflow_automations_pkey',
        'zero_workflow_github_processed_events_pkey',
        'zero_workflow_strapi_automations_pkey',
        'zero_workflow_webhook_automations_pkey',
        'zero_workflow_webhook_deliveries_pkey',
        'zero_workflows_pkey'
      ]::text[])
  ) OR EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE pg_constraint.connamespace = 'public'::regnamespace
      AND pg_constraint.conname = ANY(ARRAY[
        'agent_runs_workflow_automation_id_zero_workflow_automations_id_',
        'gmail_processed_events_automation_id_zero_workflow_automations_',
        'google_calendar_processed_events_automation_id_zero_workflow_au',
        'google_forms_automation_cursors_automation_id_zero_workflow_aut',
        'google_forms_processed_events_automation_id_zero_workflow_autom',
        'google_workspace_processed_events_automation_id_zero_workflow_a',
        'notion_workflow_pending_events_automation_id_zero_workflow_auto',
        'strapi_workflow_pending_events_automation_id_zero_workflow_auto',
        'stripe_workflow_automation_health_automation_id_zero_workflow_a',
        'workflow_user_automation_threads_workflow_id_zero_workflows_id_',
        'zero_workflow_automations_workflow_id_zero_workflows_id_fk',
        'zero_workflow_github_processed_events_automation_id_zero_workfl',
        'zero_workflow_strapi_automations_automation_id_zero_workflow_au',
        'zero_workflow_strapi_automations_integration_id_strapi_integrat',
        'zero_workflow_webhook_automations_automation_id_zero_workflow_a',
        'zero_workflow_webhook_deliveries_automation_id_zero_workflow_au',
        'zero_workflows_agent_id_agents_id_fk',
        'zero_workflow_automations_pkey',
        'zero_workflow_github_processed_events_pkey',
        'zero_workflow_strapi_automations_pkey',
        'zero_workflow_webhook_automations_pkey',
        'zero_workflow_webhook_deliveries_pkey',
        'zero_workflows_pkey',
        'zero_workflow_automations_autonomy_budget_check',
        'zero_workflow_automations_official_binding_check',
        'zero_workflow_automations_schedule_config_check',
        'zero_workflows_official_installation_check'
      ]::text[])
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition retained legacy derived identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workflow_physical_switch_relations AS expected_owner
    INNER JOIN pg_class AS relation
      ON relation.relname = expected_owner.relation_name
      AND relation.relnamespace = 'public'::regnamespace
    WHERE pg_get_userbyid(relation.relowner) <> expected_owner.owner_name
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition owner mismatch';
  END IF;

  IF EXISTS (
    WITH current_acl AS (
      SELECT
        relation.relname AS relation_name,
        CASE
          WHEN access.grantee = 0 THEN NULL
          ELSE pg_get_userbyid(access.grantee)
        END AS grantee_name,
        access.privilege_type,
        access.is_grantable
      FROM pg_class AS relation
      CROSS JOIN LATERAL aclexplode(relation.relacl) AS access
      WHERE relation.relnamespace = 'public'::regnamespace
        AND relation.relname = ANY(ARRAY[
          'workflows',
          'workflow_automations',
          'workflow_webhook_automations',
          'workflow_webhook_deliveries',
          'workflow_github_processed_events',
          'workflow_strapi_automations',
          'zero_workflows',
          'zero_workflow_automations',
          'zero_workflow_webhook_automations',
          'zero_workflow_webhook_deliveries',
          'zero_workflow_github_processed_events',
          'zero_workflow_strapi_automations'
        ]::text[])
        AND access.grantee <> relation.relowner
    ),
    differences AS (
      (
        SELECT * FROM current_acl
        EXCEPT
        SELECT * FROM workflow_physical_switch_relation_acl
      )
      UNION ALL
      (
        SELECT * FROM workflow_physical_switch_relation_acl
        EXCEPT
        SELECT * FROM current_acl
      )
    )
    SELECT 1
    FROM differences
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition relation ACL mismatch';
  END IF;

  IF EXISTS (
    WITH current_acl AS (
      SELECT
        relation.relname AS relation_name,
        attribute.attname AS column_name,
        CASE
          WHEN access.grantee = 0 THEN NULL
          ELSE pg_get_userbyid(access.grantee)
        END AS grantee_name,
        access.privilege_type,
        access.is_grantable
      FROM pg_attribute AS attribute
      INNER JOIN pg_class AS relation
        ON relation.oid = attribute.attrelid
      CROSS JOIN LATERAL aclexplode(attribute.attacl) AS access
      WHERE relation.relnamespace = 'public'::regnamespace
        AND relation.relname = ANY(ARRAY[
          'workflows',
          'workflow_automations',
          'workflow_webhook_automations',
          'workflow_webhook_deliveries',
          'workflow_github_processed_events',
          'workflow_strapi_automations',
          'zero_workflows',
          'zero_workflow_automations',
          'zero_workflow_webhook_automations',
          'zero_workflow_webhook_deliveries',
          'zero_workflow_github_processed_events',
          'zero_workflow_strapi_automations'
        ]::text[])
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND access.grantee <> relation.relowner
    ),
    differences AS (
      (
        SELECT * FROM current_acl
        EXCEPT
        SELECT * FROM workflow_physical_switch_column_acl
      )
      UNION ALL
      (
        SELECT * FROM workflow_physical_switch_column_acl
        EXCEPT
        SELECT * FROM current_acl
      )
    )
    SELECT 1
    FROM differences
  ) THEN
    RAISE EXCEPTION
      'workflow physical switch postcondition column ACL mismatch';
  END IF;
END $$;
