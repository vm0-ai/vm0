LOCK TABLE
  "public"."workflow_automations",
  "public"."workflow_github_processed_events",
  "public"."workflow_strapi_automations",
  "public"."workflow_webhook_automations",
  "public"."workflow_webhook_deliveries",
  "public"."workflows",
  "public"."zero_workflow_automations",
  "public"."zero_workflow_github_processed_events",
  "public"."zero_workflow_strapi_automations",
  "public"."zero_workflow_webhook_automations",
  "public"."zero_workflow_webhook_deliveries",
  "public"."zero_workflows"
IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $workflow_contract$
DECLARE
  actual text[];
  expected text[];
  actual_count bigint;
  actual_hash text;
  actual_columns text[];
  actual_view_definition text;
  expected_view_definition text;
  expected_view record;
BEGIN
  PERFORM set_config('search_path', 'public, pg_catalog', true);

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
      'workflow compatibility contract relation mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations'
      ]::text[])
      AND (
        relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relrowsecurity
        OR relation.relforcerowsecurity
        OR relation.reloptions IS NOT NULL
        OR relation.relreplident <> 'd'
      )
  ) THEN
    RAISE EXCEPTION
      'workflow compatibility contract canonical table options mismatch';
  END IF;

  SELECT
    count(*),
    md5(string_agg(
      concat_ws(
        '|',
        relation.relname,
        attribute.attnum::text,
        attribute.attname,
        format_type(attribute.atttypid, attribute.atttypmod),
        attribute.attnotnull::text,
        COALESCE(
          pg_get_expr(default_value.adbin, default_value.adrelid),
          '<null>'
        ),
        attribute.attidentity::text,
        attribute.attgenerated::text,
        attribute.attstorage::text,
        attribute.attcompression::text,
        COALESCE(column_collation.collname, '<null>')
      ),
      E'\n'
      ORDER BY
        relation.relname COLLATE "C",
        attribute.attnum
    ))
  INTO actual_count, actual_hash
  FROM pg_attribute AS attribute
  INNER JOIN pg_class AS relation
    ON relation.oid = attribute.attrelid
  LEFT JOIN pg_attrdef AS default_value
    ON default_value.adrelid = attribute.attrelid
    AND default_value.adnum = attribute.attnum
  LEFT JOIN pg_collation AS column_collation
    ON column_collation.oid = attribute.attcollation
    AND attribute.attcollation <> 0
  WHERE relation.relnamespace = 'public'::regnamespace
    AND relation.relname = ANY(ARRAY[
      'workflows',
      'workflow_automations',
      'workflow_webhook_automations',
      'workflow_webhook_deliveries',
      'workflow_github_processed_events',
      'workflow_strapi_automations'
    ]::text[])
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_count IS DISTINCT FROM 71
    OR actual_hash IS DISTINCT FROM '54f6df36b3ae2c5dea091161c98ff275'
  THEN
    RAISE EXCEPTION
      'workflow compatibility contract canonical column/default mismatch: count %, fingerprint %',
      actual_count,
      actual_hash;
  END IF;

  SELECT
    count(*),
    md5(string_agg(
      concat_ws(
        '|',
        table_relation.relname,
        index_relation.relname,
        index_definition.indisunique::text,
        index_definition.indisprimary::text,
        index_definition.indisvalid::text,
        index_definition.indisready::text,
        pg_get_indexdef(index_relation.oid),
        (index_relation.relowner = table_relation.relowner)::text,
        COALESCE(index_relation.relacl::text, '<null>')
      ),
      E'\n'
      ORDER BY
        table_relation.relname COLLATE "C",
        index_relation.relname COLLATE "C"
    ))
  INTO actual_count, actual_hash
  FROM pg_index AS index_definition
  INNER JOIN pg_class AS index_relation
    ON index_relation.oid = index_definition.indexrelid
  INNER JOIN pg_class AS table_relation
    ON table_relation.oid = index_definition.indrelid
  WHERE table_relation.relnamespace = 'public'::regnamespace
    AND table_relation.relname = ANY(ARRAY[
      'workflows',
      'workflow_automations',
      'workflow_webhook_automations',
      'workflow_webhook_deliveries',
      'workflow_github_processed_events',
      'workflow_strapi_automations'
    ]::text[]);

  IF actual_count IS DISTINCT FROM 21
    OR actual_hash IS DISTINCT FROM 'cacdd96f8dc45a458fe488e1cb6e9166'
  THEN
    RAISE EXCEPTION
      'workflow compatibility contract canonical index mismatch: count %, fingerprint %',
      actual_count,
      actual_hash;
  END IF;

  SELECT
    count(*),
    md5(string_agg(
      concat_ws(
        '|',
        source_relation.relname,
        constraint_definition.conname,
        constraint_definition.contype::text,
        pg_get_constraintdef(constraint_definition.oid, true),
        COALESCE(referenced_relation.relname, '<none>'),
        constraint_definition.convalidated::text,
        constraint_definition.condeferrable::text,
        constraint_definition.condeferred::text
      ),
      E'\n'
      ORDER BY
        constraint_definition.contype,
        constraint_definition.conname COLLATE "C"
    ))
  INTO actual_count, actual_hash
  FROM pg_constraint AS constraint_definition
  INNER JOIN pg_class AS source_relation
    ON source_relation.oid = constraint_definition.conrelid
  LEFT JOIN pg_class AS referenced_relation
    ON referenced_relation.oid = constraint_definition.confrelid
  WHERE constraint_definition.connamespace = 'public'::regnamespace
    AND constraint_definition.contype IN ('c', 'f', 'p')
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

  IF actual_count IS DISTINCT FROM 29
    OR actual_hash IS DISTINCT FROM 'e813fba3080b94e5bfb96fec98069cce'
  THEN
    RAISE EXCEPTION
      'workflow compatibility contract canonical constraint/FK mismatch: count %, fingerprint %',
      actual_count,
      actual_hash;
  END IF;

  FOR expected_view IN
    SELECT *
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
    ) AS view_definition(
      canonical_name,
      legacy_name,
      column_names
    )
  LOOP
    SELECT array_agg(
      attribute.attname::text
      ORDER BY attribute.attnum
    )
    INTO actual_columns
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid =
        to_regclass(format('public.%I', expected_view.legacy_name))
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF actual_columns IS DISTINCT FROM expected_view.column_names THEN
      RAISE EXCEPTION
        'workflow compatibility contract legacy view column mismatch for %: actual %, expected %',
        expected_view.legacy_name,
        actual_columns,
        expected_view.column_names;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_attribute AS legacy_column
      INNER JOIN pg_attribute AS canonical_column
        ON canonical_column.attrelid =
          to_regclass(format('public.%I', expected_view.canonical_name))
        AND canonical_column.attname = legacy_column.attname
        AND canonical_column.attnum > 0
        AND NOT canonical_column.attisdropped
      WHERE legacy_column.attrelid =
          to_regclass(format('public.%I', expected_view.legacy_name))
        AND legacy_column.attnum > 0
        AND NOT legacy_column.attisdropped
        AND (
          legacy_column.atttypid <> canonical_column.atttypid
          OR legacy_column.atttypmod <> canonical_column.atttypmod
          OR legacy_column.attcollation <> canonical_column.attcollation
        )
    ) THEN
      RAISE EXCEPTION
        'workflow compatibility contract legacy view type mismatch for %',
        expected_view.legacy_name;
    END IF;

    SELECT regexp_replace(
      btrim(pg_get_viewdef(
        to_regclass(format('public.%I', expected_view.legacy_name)),
        true
      )),
      '\s+',
      ' ',
      'g'
    )
    INTO actual_view_definition;

    SELECT format(
      'SELECT %s FROM %I;',
      string_agg(
        format('%I', column_name),
        ', '
        ORDER BY column_position
      ),
      expected_view.canonical_name
    )
    INTO expected_view_definition
    FROM unnest(expected_view.column_names)
      WITH ORDINALITY AS expected_column(column_name, column_position);

    IF actual_view_definition IS DISTINCT FROM expected_view_definition THEN
      RAISE EXCEPTION
        'workflow compatibility contract legacy view definition mismatch for %: actual %, expected %',
        expected_view.legacy_name,
        actual_view_definition,
        expected_view_definition;
    END IF;
  END LOOP;

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
      'workflow compatibility contract relation owner mismatch or inaccessible owner';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.views AS legacy_view
    WHERE legacy_view.table_schema = 'public'
      AND legacy_view.table_name = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
      AND (
        legacy_view.is_insertable_into <> 'YES'
        OR legacy_view.is_updatable <> 'YES'
        OR legacy_view.check_option <> 'NONE'
      )
  ) OR (
    SELECT count(*)
    FROM information_schema.views AS legacy_view
    WHERE legacy_view.table_schema = 'public'
      AND legacy_view.table_name = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
  ) <> 6 THEN
    RAISE EXCEPTION
      'workflow compatibility contract legacy views are not exact simple writable views';
  END IF;

  SELECT array_agg(
    rule_state.relation_name || ':' || rule_state.rule_names::text
    ORDER BY rule_state.relation_name COLLATE "C"
  )
  INTO actual
  FROM (
    SELECT
      relation.relname AS relation_name,
      array_agg(rewrite_rule.rulename ORDER BY rewrite_rule.rulename COLLATE "C")
        AS rule_names
    FROM pg_class AS relation
    LEFT JOIN pg_rewrite AS rewrite_rule
      ON rewrite_rule.ev_class = relation.oid
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
    GROUP BY relation.relname
  ) AS rule_state;

  SELECT array_agg(
    relation_name || ':' || ARRAY['_RETURN']::text[]::text
    ORDER BY relation_name COLLATE "C"
  )
  INTO expected
  FROM unnest(ARRAY[
    'zero_workflows',
    'zero_workflow_automations',
    'zero_workflow_webhook_automations',
    'zero_workflow_webhook_deliveries',
    'zero_workflow_github_processed_events',
    'zero_workflow_strapi_automations'
  ]::text[]) AS expected_relation(relation_name);

  IF actual IS DISTINCT FROM expected OR EXISTS (
    SELECT 1
    FROM pg_rewrite AS rewrite_rule
    INNER JOIN pg_class AS relation
      ON relation.oid = rewrite_rule.ev_class
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
      AND (
        rewrite_rule.rulename <> '_RETURN'
        OR rewrite_rule.ev_type <> '1'
        OR rewrite_rule.ev_enabled <> 'O'
        OR NOT rewrite_rule.is_instead
      )
  ) THEN
    RAISE EXCEPTION
      'workflow compatibility contract legacy view rule mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_rewrite AS rewrite_rule
    INNER JOIN pg_class AS relation
      ON relation.oid = rewrite_rule.ev_class
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'workflows',
        'workflow_automations',
        'workflow_webhook_automations',
        'workflow_webhook_deliveries',
        'workflow_github_processed_events',
        'workflow_strapi_automations'
      ]::text[])
  ) OR EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_definition
    INNER JOIN pg_class AS relation
      ON relation.oid = trigger_definition.tgrelid
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
      AND NOT trigger_definition.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'workflow compatibility contract unexpected canonical rule or user trigger';
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
        access.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
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
      'workflow compatibility contract unsupported or dangling grant';
  END IF;

  WITH legacy_view AS (
    SELECT
      relation.oid AS relation_oid,
      relation.relname AS relation_name,
      relation.reltype AS row_type_oid,
      row_type.typarray AS array_type_oid,
      rewrite_rule.oid AS rewrite_rule_oid
    FROM pg_class AS relation
    INNER JOIN pg_type AS row_type
      ON row_type.oid = relation.reltype
    INNER JOIN pg_rewrite AS rewrite_rule
      ON rewrite_rule.ev_class = relation.oid
      AND rewrite_rule.rulename = '_RETURN'
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
  ), dependency_count AS (
    SELECT
      legacy_view.relation_name,
      count(dependency.*) AS dependency_count
    FROM legacy_view
    LEFT JOIN pg_depend AS dependency
      ON (
        dependency.refclassid = 'pg_class'::regclass
        AND dependency.refobjid = legacy_view.relation_oid
      ) OR (
        dependency.refclassid = 'pg_type'::regclass
        AND dependency.refobjid IN (
          legacy_view.row_type_oid,
          legacy_view.array_type_oid
        )
      )
    GROUP BY legacy_view.relation_name
  )
  SELECT array_agg(
    relation_name || ':' || dependency_count::text
    ORDER BY relation_name COLLATE "C"
  )
  INTO actual
  FROM dependency_count;

  SELECT array_agg(
    relation_name || ':3'
    ORDER BY relation_name COLLATE "C"
  )
  INTO expected
  FROM unnest(ARRAY[
    'zero_workflows',
    'zero_workflow_automations',
    'zero_workflow_webhook_automations',
    'zero_workflow_webhook_deliveries',
    'zero_workflow_github_processed_events',
    'zero_workflow_strapi_automations'
  ]::text[]) AS expected_relation(relation_name);

  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'workflow compatibility contract dependency count mismatch: actual %, expected %',
      actual,
      expected;
  END IF;

  WITH legacy_view AS (
    SELECT
      relation.oid AS relation_oid,
      relation.relname AS relation_name,
      relation.reltype AS row_type_oid,
      row_type.typarray AS array_type_oid,
      rewrite_rule.oid AS rewrite_rule_oid
    FROM pg_class AS relation
    INNER JOIN pg_type AS row_type
      ON row_type.oid = relation.reltype
    INNER JOIN pg_rewrite AS rewrite_rule
      ON rewrite_rule.ev_class = relation.oid
      AND rewrite_rule.rulename = '_RETURN'
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY(ARRAY[
        'zero_workflows',
        'zero_workflow_automations',
        'zero_workflow_webhook_automations',
        'zero_workflow_webhook_deliveries',
        'zero_workflow_github_processed_events',
        'zero_workflow_strapi_automations'
      ]::text[])
  ), unexpected_dependency AS (
    SELECT
      legacy_view.relation_name,
      dependency.classid,
      dependency.objid,
      dependency.objsubid,
      dependency.refclassid,
      dependency.refobjid,
      dependency.refobjsubid,
      dependency.deptype
    FROM legacy_view
    INNER JOIN pg_depend AS dependency
      ON (
        dependency.refclassid = 'pg_class'::regclass
        AND dependency.refobjid = legacy_view.relation_oid
      ) OR (
        dependency.refclassid = 'pg_type'::regclass
        AND dependency.refobjid IN (
          legacy_view.row_type_oid,
          legacy_view.array_type_oid
        )
      )
    WHERE NOT (
      (
        dependency.classid = 'pg_rewrite'::regclass
        AND dependency.objid = legacy_view.rewrite_rule_oid
        AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_class'::regclass
        AND dependency.refobjid = legacy_view.relation_oid
        AND dependency.refobjsubid = 0
        AND dependency.deptype = 'i'
      ) OR (
        dependency.classid = 'pg_type'::regclass
        AND dependency.objid = legacy_view.row_type_oid
        AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_class'::regclass
        AND dependency.refobjid = legacy_view.relation_oid
        AND dependency.refobjsubid = 0
        AND dependency.deptype = 'i'
      ) OR (
        dependency.classid = 'pg_type'::regclass
        AND dependency.objid = legacy_view.array_type_oid
        AND dependency.objsubid = 0
        AND dependency.refclassid = 'pg_type'::regclass
        AND dependency.refobjid = legacy_view.row_type_oid
        AND dependency.refobjsubid = 0
        AND dependency.deptype = 'i'
      )
    )

    UNION ALL

    SELECT
      legacy_view.relation_name,
      dependency.classid,
      dependency.objid,
      dependency.objsubid,
      dependency.refclassid,
      dependency.refobjid,
      dependency.refobjsubid,
      dependency.deptype
    FROM legacy_view
    INNER JOIN pg_depend AS dependency
      ON dependency.refclassid = 'pg_rewrite'::regclass
      AND dependency.refobjid = legacy_view.rewrite_rule_oid
  )
  SELECT array_agg(
    relation_name || ':' ||
      pg_describe_object(classid, objid, objsubid)
    ORDER BY
      relation_name COLLATE "C",
      classid,
      objid,
      objsubid
  )
  INTO actual
  FROM unexpected_dependency;

  IF actual IS NOT NULL THEN
    RAISE EXCEPTION
      'workflow compatibility contract unexpected persisted dependency: %',
      actual;
  END IF;

  IF EXISTS (
    WITH legacy_view AS (
      SELECT
        relation.oid AS relation_oid,
        relation.reltype AS row_type_oid,
        row_type.typarray AS array_type_oid,
        rewrite_rule.oid AS rewrite_rule_oid
      FROM pg_class AS relation
      INNER JOIN pg_type AS row_type
        ON row_type.oid = relation.reltype
      INNER JOIN pg_rewrite AS rewrite_rule
        ON rewrite_rule.ev_class = relation.oid
        AND rewrite_rule.rulename = '_RETURN'
      WHERE relation.relnamespace = 'public'::regnamespace
        AND relation.relname = ANY(ARRAY[
          'zero_workflows',
          'zero_workflow_automations',
          'zero_workflow_webhook_automations',
          'zero_workflow_webhook_deliveries',
          'zero_workflow_github_processed_events',
          'zero_workflow_strapi_automations'
        ]::text[])
    )
    SELECT 1
    FROM legacy_view
    INNER JOIN pg_shdepend AS shared_dependency
      ON (
        shared_dependency.classid = 'pg_class'::regclass
        AND shared_dependency.objid = legacy_view.relation_oid
      ) OR (
        shared_dependency.classid = 'pg_type'::regclass
        AND shared_dependency.objid IN (
          legacy_view.row_type_oid,
          legacy_view.array_type_oid
        )
      ) OR (
        shared_dependency.classid = 'pg_rewrite'::regclass
        AND shared_dependency.objid = legacy_view.rewrite_rule_oid
      ) OR (
        shared_dependency.refclassid = 'pg_class'::regclass
        AND shared_dependency.refobjid = legacy_view.relation_oid
      ) OR (
        shared_dependency.refclassid = 'pg_type'::regclass
        AND shared_dependency.refobjid IN (
          legacy_view.row_type_oid,
          legacy_view.array_type_oid
        )
      ) OR (
        shared_dependency.refclassid = 'pg_rewrite'::regclass
        AND shared_dependency.refobjid = legacy_view.rewrite_rule_oid
      )
    WHERE shared_dependency.refclassid <> 'pg_authid'::regclass
      OR shared_dependency.deptype NOT IN ('a', 'o')
  ) THEN
    RAISE EXCEPTION
      'workflow compatibility contract unexpected shared dependency';
  END IF;
END $workflow_contract$;
--> statement-breakpoint
DROP VIEW
  "public"."zero_workflow_automations",
  "public"."zero_workflow_github_processed_events",
  "public"."zero_workflow_strapi_automations",
  "public"."zero_workflow_webhook_automations",
  "public"."zero_workflow_webhook_deliveries",
  "public"."zero_workflows";
