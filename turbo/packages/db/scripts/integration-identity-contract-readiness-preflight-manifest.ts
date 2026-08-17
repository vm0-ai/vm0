import { createHash } from "node:crypto";

export const INTEGRATION_IDENTITY_TABLES = [
  {
    tableName: "agentphone_user_agent_preferences",
    triggerName: "sync_agentphone_user_agent_preferences_identity_0930",
  },
  {
    tableName: "agentphone_user_links",
    triggerName: "sync_agentphone_user_links_identity_0930",
  },
  {
    tableName: "feishu_org_connections",
    triggerName: "sync_feishu_org_connections_identity_0930",
  },
  {
    tableName: "feishu_user_agent_preferences",
    triggerName: "sync_feishu_user_agent_preferences_identity_0930",
  },
  {
    tableName: "github_user_links",
    triggerName: "sync_github_user_links_identity_0930",
  },
  {
    tableName: "slack_org_connections",
    triggerName: "sync_slack_org_connections_identity_0930",
  },
  {
    tableName: "slack_user_agent_preferences",
    triggerName: "sync_slack_user_agent_preferences_identity_0930",
  },
  {
    tableName: "teams_org_connections",
    triggerName: "sync_teams_org_connections_identity_0930",
  },
  {
    tableName: "teams_user_agent_preferences",
    triggerName: "sync_teams_user_agent_preferences_identity_0930",
  },
  {
    tableName: "telegram_official_user_links",
    triggerName: "sync_telegram_official_user_links_identity_0930",
  },
  {
    tableName: "telegram_user_agent_preferences",
    triggerName: "sync_telegram_user_agent_preferences_identity_0930",
  },
  {
    tableName: "telegram_user_links",
    triggerName: "sync_telegram_user_links_identity_0930",
  },
] as const;

export type IntegrationIdentityTableName =
  (typeof INTEGRATION_IDENTITY_TABLES)[number]["tableName"];

export const CATALOG_DEPENDENCY_KINDS = [
  "columns",
  "primaryKeys",
  "constraints",
  "defaultsAndGenerated",
  "indexes",
  "triggers",
  "functions",
  "rewriteDependents",
  "otherDependents",
] as const;

export type CatalogDependencyKind = (typeof CATALOG_DEPENDENCY_KINDS)[number];

export interface CatalogDependencySourceRow {
  readonly kind: string;
  readonly identity: string;
  readonly definition: string;
}

const CATALOG_DEFINITION_DOMAIN =
  "vm0:integration-identity-contract-readiness-preflight:catalog-definition:v1";

function hashDefinition(definition: string): string {
  return createHash("sha256")
    .update(CATALOG_DEFINITION_DOMAIN)
    .update("\0")
    .update(definition)
    .digest("hex");
}

export function catalogManifestEntry(
  identity: string,
  definition: string,
): string {
  return `${identity}|definition_sha256=${hashDefinition(definition)}`;
}

function catalogManifestDigestEntry(
  identity: string,
  definitionDigest: string,
): string {
  return `${identity}|definition_sha256=${definitionDigest}`;
}

export function normalizeCatalogDependencyRow(
  row: CatalogDependencySourceRow,
): { kind: CatalogDependencyKind; entry: string } {
  if (
    !CATALOG_DEPENDENCY_KINDS.some((kind) => {
      return kind === row.kind;
    })
  ) {
    throw new Error("unknown catalog dependency kind");
  }
  if (row.identity.length === 0 || row.definition.length === 0) {
    throw new Error("incomplete catalog dependency row");
  }
  return {
    kind: row.kind as CatalogDependencyKind,
    entry: catalogManifestEntry(row.identity, row.definition),
  };
}

const COLUMN_DEFINITION = "type=text|not_null=true|identity=|generated=";

const expectedColumns = INTEGRATION_IDENTITY_TABLES.flatMap(({ tableName }) => {
  return ["user_id", "vm0_user_id"].map((columnName) => {
    return catalogManifestEntry(
      `public.${tableName}|${columnName}`,
      COLUMN_DEFINITION,
    );
  });
});

const expectedPrimaryKeys = [
  catalogManifestEntry(
    "public.agentphone_user_agent_preferences|agentphone_user_agent_preferences_pkey",
    "PRIMARY KEY (vm0_user_id, org_id)|validated=true|deferrable=false|initially_deferred=false",
  ),
  catalogManifestEntry(
    "public.feishu_user_agent_preferences|feishu_user_agent_preferences_pkey",
    "PRIMARY KEY (vm0_user_id, org_id)|validated=true|deferrable=false|initially_deferred=false",
  ),
  catalogManifestEntry(
    "public.slack_user_agent_preferences|slack_user_agent_preferences_pkey",
    "PRIMARY KEY (vm0_user_id, org_id)|validated=true|deferrable=false|initially_deferred=false",
  ),
  catalogManifestEntry(
    "public.teams_user_agent_preferences|teams_user_agent_preferences_pkey",
    "PRIMARY KEY (vm0_user_id, org_id)|validated=true|deferrable=false|initially_deferred=false",
  ),
  catalogManifestEntry(
    "public.telegram_user_agent_preferences|telegram_user_agent_preferences_pkey",
    "PRIMARY KEY (vm0_user_id, org_id)|validated=true|deferrable=false|initially_deferred=false",
  ),
];

const expectedIndexDefinitions: readonly (readonly [string, string])[] = [
  [
    "public.agentphone_user_agent_preferences|agentphone_user_agent_preferences_pkey",
    "CREATE UNIQUE INDEX agentphone_user_agent_preferences_pkey ON public.agentphone_user_agent_preferences USING btree (vm0_user_id, org_id)|valid=true|ready=true|unique=true|primary=true",
  ],
  [
    "public.agentphone_user_agent_preferences|idx_agentphone_user_agent_preferences_user_org",
    "CREATE UNIQUE INDEX idx_agentphone_user_agent_preferences_user_org ON public.agentphone_user_agent_preferences USING btree (user_id, org_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.agentphone_user_links|idx_agentphone_user_links_user_org",
    "CREATE UNIQUE INDEX idx_agentphone_user_links_user_org ON public.agentphone_user_links USING btree (user_id, org_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.agentphone_user_links|idx_agentphone_user_links_vm0_org",
    "CREATE UNIQUE INDEX idx_agentphone_user_links_vm0_org ON public.agentphone_user_links USING btree (vm0_user_id, org_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.feishu_org_connections|idx_feishu_org_connections_user_id_installation",
    "CREATE INDEX idx_feishu_org_connections_user_id_installation ON public.feishu_org_connections USING btree (user_id, installation_id)|valid=true|ready=true|unique=false|primary=false",
  ],
  [
    "public.feishu_org_connections|idx_feishu_org_connections_vm0_installation",
    "CREATE INDEX idx_feishu_org_connections_vm0_installation ON public.feishu_org_connections USING btree (vm0_user_id, installation_id)|valid=true|ready=true|unique=false|primary=false",
  ],
  [
    "public.feishu_user_agent_preferences|feishu_user_agent_preferences_pkey",
    "CREATE UNIQUE INDEX feishu_user_agent_preferences_pkey ON public.feishu_user_agent_preferences USING btree (vm0_user_id, org_id)|valid=true|ready=true|unique=true|primary=true",
  ],
  [
    "public.feishu_user_agent_preferences|idx_feishu_user_agent_preferences_user_org",
    "CREATE UNIQUE INDEX idx_feishu_user_agent_preferences_user_org ON public.feishu_user_agent_preferences USING btree (user_id, org_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.slack_org_connections|idx_slack_org_connections_user_id_workspace",
    "CREATE INDEX idx_slack_org_connections_user_id_workspace ON public.slack_org_connections USING btree (user_id, slack_workspace_id)|valid=true|ready=true|unique=false|primary=false",
  ],
  [
    "public.slack_org_connections|idx_slack_org_connections_vm0_user_workspace",
    "CREATE INDEX idx_slack_org_connections_vm0_user_workspace ON public.slack_org_connections USING btree (vm0_user_id, slack_workspace_id)|valid=true|ready=true|unique=false|primary=false",
  ],
  [
    "public.slack_user_agent_preferences|idx_slack_user_agent_preferences_user_org",
    "CREATE UNIQUE INDEX idx_slack_user_agent_preferences_user_org ON public.slack_user_agent_preferences USING btree (user_id, org_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.slack_user_agent_preferences|slack_user_agent_preferences_pkey",
    "CREATE UNIQUE INDEX slack_user_agent_preferences_pkey ON public.slack_user_agent_preferences USING btree (vm0_user_id, org_id)|valid=true|ready=true|unique=true|primary=true",
  ],
  [
    "public.teams_org_connections|idx_teams_org_connections_user_id_tenant",
    "CREATE INDEX idx_teams_org_connections_user_id_tenant ON public.teams_org_connections USING btree (user_id, teams_tenant_id)|valid=true|ready=true|unique=false|primary=false",
  ],
  [
    "public.teams_org_connections|idx_teams_org_connections_vm0_tenant",
    "CREATE INDEX idx_teams_org_connections_vm0_tenant ON public.teams_org_connections USING btree (vm0_user_id, teams_tenant_id)|valid=true|ready=true|unique=false|primary=false",
  ],
  [
    "public.teams_user_agent_preferences|idx_teams_user_agent_preferences_user_org",
    "CREATE UNIQUE INDEX idx_teams_user_agent_preferences_user_org ON public.teams_user_agent_preferences USING btree (user_id, org_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.teams_user_agent_preferences|teams_user_agent_preferences_pkey",
    "CREATE UNIQUE INDEX teams_user_agent_preferences_pkey ON public.teams_user_agent_preferences USING btree (vm0_user_id, org_id)|valid=true|ready=true|unique=true|primary=true",
  ],
  [
    "public.telegram_official_user_links|idx_telegram_official_user_links_user_org",
    "CREATE UNIQUE INDEX idx_telegram_official_user_links_user_org ON public.telegram_official_user_links USING btree (user_id, org_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.telegram_official_user_links|idx_telegram_official_user_links_vm0_org",
    "CREATE UNIQUE INDEX idx_telegram_official_user_links_vm0_org ON public.telegram_official_user_links USING btree (vm0_user_id, org_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.telegram_user_agent_preferences|idx_telegram_user_agent_preferences_user_org",
    "CREATE UNIQUE INDEX idx_telegram_user_agent_preferences_user_org ON public.telegram_user_agent_preferences USING btree (user_id, org_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.telegram_user_agent_preferences|telegram_user_agent_preferences_pkey",
    "CREATE UNIQUE INDEX telegram_user_agent_preferences_pkey ON public.telegram_user_agent_preferences USING btree (vm0_user_id, org_id)|valid=true|ready=true|unique=true|primary=true",
  ],
  [
    "public.telegram_user_links|idx_telegram_user_links_user_id_installation",
    "CREATE UNIQUE INDEX idx_telegram_user_links_user_id_installation ON public.telegram_user_links USING btree (user_id, installation_id)|valid=true|ready=true|unique=true|primary=false",
  ],
  [
    "public.telegram_user_links|idx_telegram_user_links_vm0_installation",
    "CREATE UNIQUE INDEX idx_telegram_user_links_vm0_installation ON public.telegram_user_links USING btree (vm0_user_id, installation_id)|valid=true|ready=true|unique=true|primary=false",
  ],
];

const expectedIndexes = expectedIndexDefinitions.map(
  ([identity, definition]) => {
    return catalogManifestEntry(identity, definition);
  },
);

const expectedTriggers = INTEGRATION_IDENTITY_TABLES.map(
  ({ tableName, triggerName }) => {
    return catalogManifestEntry(
      `public.${tableName}|${triggerName}`,
      `CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE OF vm0_user_id, user_id ON public.${tableName} FOR EACH ROW EXECUTE FUNCTION sync_integration_user_identity_0930()|enabled=O`,
    );
  },
);

const expectedFunctions = [
  // Domain-separated SHA-256 of the exact prosrc installed by 0930_past_jetstream.
  catalogManifestDigestEntry(
    "public.sync_integration_user_identity_0930()|kind=f|result=trigger|language=plpgsql|volatility=v|security_definer=false",
    "50622a23cb618306571dbed28ec66a1c1ea5afd72b929c0292ac93342a455cee",
  ),
];

export const EXPECTED_CATALOG_DEPENDENCIES = {
  columns: expectedColumns,
  primaryKeys: expectedPrimaryKeys,
  constraints: [],
  defaultsAndGenerated: [],
  indexes: expectedIndexes,
  triggers: expectedTriggers,
  functions: expectedFunctions,
  rewriteDependents: [],
  otherDependents: [],
} as const satisfies Record<CatalogDependencyKind, readonly string[]>;

/**
 * Discover every Contract-relevant dependency on the two integration identity
 * columns. Definitions are returned only to the in-process SHA-256 normalizer;
 * no raw definition is part of the result schema or workflow output.
 */
export const CATALOG_DEPENDENCY_QUERY = `
WITH RECURSIVE target_table_names("table_name") AS (
  VALUES
    ('agentphone_user_agent_preferences'),
    ('agentphone_user_links'),
    ('feishu_org_connections'),
    ('feishu_user_agent_preferences'),
    ('github_user_links'),
    ('slack_org_connections'),
    ('slack_user_agent_preferences'),
    ('teams_org_connections'),
    ('teams_user_agent_preferences'),
    ('telegram_official_user_links'),
    ('telegram_user_agent_preferences'),
    ('telegram_user_links')
),
target_relations AS (
  SELECT "relation"."oid", "relation"."relname"
  FROM "pg_class" AS "relation"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  INNER JOIN target_table_names AS "target"
    ON "target"."table_name" = "relation"."relname"
  WHERE "namespace"."nspname" = 'public'
    AND "relation"."relkind" IN ('r', 'p')
),
identity_columns AS (
  SELECT
    "attribute"."attrelid" AS "relid",
    "attribute"."attnum" AS "attnum",
    "attribute"."attname" AS "attname"
  FROM "pg_attribute" AS "attribute"
  INNER JOIN target_relations AS "target"
    ON "target"."oid" = "attribute"."attrelid"
  WHERE "attribute"."attname" IN ('user_id', 'vm0_user_id')
    AND "attribute"."attnum" > 0
    AND NOT "attribute"."attisdropped"
),
rewrite_relation_closure("oid") AS (
  SELECT DISTINCT "rewrite"."ev_class"
  FROM "pg_depend" AS "dependency"
  INNER JOIN identity_columns AS "column"
    ON "dependency"."refclassid" = 'pg_class'::regclass
    AND "dependency"."refobjid" = "column"."relid"
    AND "dependency"."refobjsubid" = "column"."attnum"
  INNER JOIN "pg_rewrite" AS "rewrite"
    ON "dependency"."classid" = 'pg_rewrite'::regclass
    AND "dependency"."objid" = "rewrite"."oid"
  WHERE "dependency"."deptype" = 'n'
  UNION
  SELECT DISTINCT "rewrite"."ev_class"
  FROM rewrite_relation_closure AS "referenced"
  INNER JOIN "pg_depend" AS "dependency"
    ON "dependency"."refclassid" = 'pg_class'::regclass
    AND "dependency"."refobjid" = "referenced"."oid"
    AND "dependency"."classid" = 'pg_rewrite'::regclass
    AND "dependency"."deptype" = 'n'
  INNER JOIN "pg_rewrite" AS "rewrite"
    ON "rewrite"."oid" = "dependency"."objid"
),
columns AS (
  SELECT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
      "attribute"."attname" AS "identity",
    'type=' || format_type("attribute"."atttypid", "attribute"."atttypmod") ||
      '|not_null=' || "attribute"."attnotnull"::text ||
      '|identity=' || "attribute"."attidentity"::text ||
      '|generated=' || "attribute"."attgenerated"::text AS "definition"
  FROM identity_columns AS "column"
  INNER JOIN "pg_attribute" AS "attribute"
    ON "attribute"."attrelid" = "column"."relid"
    AND "attribute"."attnum" = "column"."attnum"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "attribute"."attrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
),
primary_keys AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
      "constraint"."conname" AS "identity",
    pg_get_constraintdef("constraint"."oid", false) ||
      '|validated=' || "constraint"."convalidated"::text ||
      '|deferrable=' || "constraint"."condeferrable"::text ||
      '|initially_deferred=' || "constraint"."condeferred"::text AS "definition"
  FROM "pg_constraint" AS "constraint"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "constraint"."conrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  WHERE "constraint"."contype" = 'p'
    AND EXISTS (
      SELECT 1
      FROM unnest("constraint"."conkey") AS "key"("attnum")
      INNER JOIN identity_columns AS "column"
        ON "column"."relid" = "constraint"."conrelid"
        AND "column"."attnum" = "key"."attnum"
    )
),
constraints AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
      "constraint"."conname" AS "identity",
    'type=' || "constraint"."contype"::text || '|' ||
      pg_get_constraintdef("constraint"."oid", false) ||
      '|validated=' || "constraint"."convalidated"::text ||
      '|deferrable=' || "constraint"."condeferrable"::text ||
      '|initially_deferred=' || "constraint"."condeferred"::text AS "definition"
  FROM "pg_constraint" AS "constraint"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "constraint"."conrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  WHERE "constraint"."contype" NOT IN ('p', 'n')
    AND (
      EXISTS (
        SELECT 1
        FROM unnest("constraint"."conkey") AS "key"("attnum")
        INNER JOIN identity_columns AS "column"
          ON "column"."relid" = "constraint"."conrelid"
          AND "column"."attnum" = "key"."attnum"
      )
      OR EXISTS (
        SELECT 1
        FROM "pg_depend" AS "dependency"
        INNER JOIN identity_columns AS "column"
          ON "dependency"."refclassid" = 'pg_class'::regclass
          AND "dependency"."refobjid" = "column"."relid"
          AND "dependency"."refobjsubid" = "column"."attnum"
        WHERE "dependency"."classid" = 'pg_constraint'::regclass
          AND "dependency"."objid" = "constraint"."oid"
      )
    )
),
defaults_and_generated AS (
  SELECT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
      "attribute"."attname" AS "identity",
    'generated=' || "attribute"."attgenerated"::text || '|' ||
      pg_get_expr("default"."adbin", "default"."adrelid", false) AS "definition"
  FROM "pg_attrdef" AS "default"
  INNER JOIN "pg_attribute" AS "attribute"
    ON "attribute"."attrelid" = "default"."adrelid"
    AND "attribute"."attnum" = "default"."adnum"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "default"."adrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  WHERE EXISTS (
      SELECT 1
      FROM identity_columns AS "column"
      WHERE "column"."relid" = "default"."adrelid"
        AND "column"."attnum" = "default"."adnum"
    )
    OR EXISTS (
      SELECT 1
      FROM "pg_depend" AS "dependency"
      INNER JOIN identity_columns AS "column"
        ON "dependency"."refclassid" = 'pg_class'::regclass
        AND "dependency"."refobjid" = "column"."relid"
        AND "dependency"."refobjsubid" = "column"."attnum"
      WHERE "dependency"."classid" = 'pg_attrdef'::regclass
        AND "dependency"."objid" = "default"."oid"
    )
),
indexes AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "table"."relname" || '|' ||
      "index_relation"."relname" AS "identity",
    pg_get_indexdef("index"."indexrelid", 0, false) ||
      '|valid=' || "index"."indisvalid"::text ||
      '|ready=' || "index"."indisready"::text ||
      '|unique=' || "index"."indisunique"::text ||
      '|primary=' || "index"."indisprimary"::text AS "definition"
  FROM "pg_index" AS "index"
  INNER JOIN "pg_class" AS "index_relation"
    ON "index_relation"."oid" = "index"."indexrelid"
  INNER JOIN "pg_class" AS "table"
    ON "table"."oid" = "index"."indrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "table"."relnamespace"
  WHERE EXISTS (
      SELECT 1
      FROM unnest("index"."indkey") AS "key"("attnum")
      INNER JOIN identity_columns AS "column"
        ON "column"."relid" = "index"."indrelid"
        AND "column"."attnum" = "key"."attnum"
    )
    OR EXISTS (
      SELECT 1
      FROM "pg_depend" AS "dependency"
      INNER JOIN identity_columns AS "column"
        ON "dependency"."refclassid" = 'pg_class'::regclass
        AND "dependency"."refobjid" = "column"."relid"
        AND "dependency"."refobjsubid" = "column"."attnum"
      WHERE "dependency"."classid" = 'pg_class'::regclass
        AND "dependency"."objid" = "index"."indexrelid"
    )
),
triggers AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
      "trigger"."tgname" AS "identity",
    pg_get_triggerdef("trigger"."oid", false) ||
      '|enabled=' || "trigger"."tgenabled"::text AS "definition",
    "trigger"."tgfoid" AS "function_oid"
  FROM "pg_trigger" AS "trigger"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "trigger"."tgrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  INNER JOIN "pg_proc" AS "function"
    ON "function"."oid" = "trigger"."tgfoid"
  WHERE NOT "trigger"."tgisinternal"
    AND (
      "function"."proname" = 'sync_integration_user_identity_0930'
      OR lower("function"."prosrc") LIKE '%vm0_user_id%'
      OR EXISTS (
        SELECT 1
        FROM "pg_depend" AS "dependency"
        INNER JOIN identity_columns AS "column"
          ON "dependency"."refclassid" = 'pg_class'::regclass
          AND "dependency"."refobjid" = "column"."relid"
          AND "dependency"."refobjsubid" = "column"."attnum"
        WHERE "dependency"."classid" = 'pg_trigger'::regclass
          AND "dependency"."objid" = "trigger"."oid"
      )
    )
),
functions AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "function"."proname" || '(' ||
      pg_get_function_identity_arguments("function"."oid") || ')|' ||
      'kind=' || "function"."prokind"::text ||
      '|result=' || pg_get_function_result("function"."oid") ||
      '|language=' || "language"."lanname" ||
      '|volatility=' || "function"."provolatile"::text ||
      '|security_definer=' || "function"."prosecdef"::text AS "identity",
    "function"."prosrc" AS "definition"
  FROM "pg_proc" AS "function"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "function"."pronamespace"
  INNER JOIN "pg_language" AS "language"
    ON "language"."oid" = "function"."prolang"
  WHERE "function"."oid" IN (SELECT "function_oid" FROM triggers)
    OR (
      "namespace"."nspname" = 'public'
      AND lower("function"."prosrc") LIKE '%vm0_user_id%'
    )
),
rewrite_dependents AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "relation"."relname" ||
      '|relation_kind=' ||
      CASE "relation"."relkind"
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized_view'
        ELSE 'relation'
      END ||
      '|rule=' || "rewrite"."rulename" ||
      '|event=' || "rewrite"."ev_type"::text ||
      '|instead=' || "rewrite"."is_instead"::text AS "identity",
    pg_get_ruledef("rewrite"."oid", false) AS "definition"
  FROM "pg_rewrite" AS "rewrite"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "rewrite"."ev_class"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  WHERE "rewrite"."ev_class" IN (SELECT "oid" FROM rewrite_relation_closure)
),
other_dependents AS (
  SELECT DISTINCT
    "dependency"."classid"::regclass::text ||
      '|dependency_type=' || "dependency"."deptype"::text ||
      '|object=' || pg_describe_object(
        "dependency"."classid",
        "dependency"."objid",
        "dependency"."objsubid"
      ) ||
      '|referenced=' || pg_describe_object(
        "dependency"."refclassid",
        "dependency"."refobjid",
        "dependency"."refobjsubid"
      ) AS "identity",
    'structural-dependency' AS "definition"
  FROM "pg_depend" AS "dependency"
  LEFT JOIN "pg_class" AS "dependent_relation"
    ON "dependency"."classid" = 'pg_class'::regclass
    AND "dependent_relation"."oid" = "dependency"."objid"
  WHERE (
      EXISTS (
        SELECT 1
        FROM identity_columns AS "column"
        WHERE "dependency"."refclassid" = 'pg_class'::regclass
          AND "dependency"."refobjid" = "column"."relid"
          AND "dependency"."refobjsubid" = "column"."attnum"
      )
      OR (
        "dependency"."refclassid" = 'pg_proc'::regclass
        AND "dependency"."refobjid" IN (
          SELECT "function_oid" FROM triggers
        )
      )
    )
    AND "dependency"."deptype" <> 'i'
    AND "dependency"."classid" NOT IN (
      'pg_attrdef'::regclass,
      'pg_constraint'::regclass,
      'pg_rewrite'::regclass,
      'pg_trigger'::regclass
    )
    AND NOT (
      "dependency"."classid" = 'pg_class'::regclass
      AND "dependent_relation"."relkind" IN ('i', 'I')
    )
)
SELECT 'columns' AS "kind", "identity", "definition" FROM columns
UNION ALL SELECT 'primaryKeys', "identity", "definition" FROM primary_keys
UNION ALL SELECT 'constraints', "identity", "definition" FROM constraints
UNION ALL SELECT 'defaultsAndGenerated', "identity", "definition" FROM defaults_and_generated
UNION ALL SELECT 'indexes', "identity", "definition" FROM indexes
UNION ALL SELECT 'triggers', "identity", "definition" FROM triggers
UNION ALL SELECT 'functions', "identity", "definition" FROM functions
UNION ALL SELECT 'rewriteDependents', "identity", "definition" FROM rewrite_dependents
UNION ALL SELECT 'otherDependents', "identity", "definition" FROM other_dependents
ORDER BY "kind", "identity"
`;
