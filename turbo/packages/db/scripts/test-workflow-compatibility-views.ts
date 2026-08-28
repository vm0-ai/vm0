import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1003_rich_yellow_claw";
const expansionMigration = "1004_workflow_compatibility_views";
const refreshPreviousMigration = "1019_sturdy_firestar";
const refreshMigration = "1020_refresh_workflow_compatibility_views";
const testDatabase = "migration_workflow_compatibility_views";

const historicalRelationDefinitions = [
  {
    canonical: "workflows",
    legacy: "zero_workflows",
    columns: [
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
    ],
  },
  {
    canonical: "workflow_automations",
    legacy: "zero_workflow_automations",
    columns: [
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
    ],
  },
  {
    canonical: "workflow_webhook_automations",
    legacy: "zero_workflow_webhook_automations",
    columns: [
      "automation_id",
      "token_hash",
      "encrypted_token",
      "encrypted_secret",
      "secret_last_four",
      "disabled_reason",
      "last_received_at",
      "created_at",
      "updated_at",
    ],
  },
  {
    canonical: "workflow_webhook_deliveries",
    legacy: "zero_workflow_webhook_deliveries",
    columns: [
      "id",
      "automation_id",
      "delivery_key",
      "body_sha256",
      "status",
      "run_id",
      "error_message",
      "received_at",
      "created_at",
    ],
  },
  {
    canonical: "workflow_github_processed_events",
    legacy: "zero_workflow_github_processed_events",
    columns: [
      "id",
      "automation_id",
      "github_delivery_id",
      "repo",
      "subject_type",
      "subject_number",
      "action",
      "label_name_normalized",
      "created_at",
    ],
  },
  {
    canonical: "workflow_strapi_automations",
    legacy: "zero_workflow_strapi_automations",
    columns: ["automation_id", "integration_id", "created_at"],
  },
] as const;

const relationDefinitions = [
  {
    ...historicalRelationDefinitions[0],
    columns: [
      ...historicalRelationDefinitions[0].columns,
      "official_definition_name",
      "official_installation_state",
    ],
  },
  {
    ...historicalRelationDefinitions[1],
    columns: [
      ...historicalRelationDefinitions[1].columns,
      "official_blueprint_key",
      "official_applied_fingerprint",
      "official_reconciliation_status",
      "official_parameter_bindings",
      "official_intended_enabled",
      "official_result_email_enabled",
    ],
  },
  historicalRelationDefinitions[2],
  historicalRelationDefinitions[3],
  historicalRelationDefinitions[4],
  historicalRelationDefinitions[5],
] as const;

const legacyRelationNames = relationDefinitions.map(({ legacy }) => {
  return legacy;
});
const canonicalRelationNames = relationDefinitions.map(({ canonical }) => {
  return canonical;
});
const allRelationNames = [...legacyRelationNames, ...canonicalRelationNames];

type LegacyRelationName = (typeof legacyRelationNames)[number];
type CanonicalRelationName = (typeof canonicalRelationNames)[number];
type RelationName = (typeof allRelationNames)[number];

const expectedExplicitIndexNames = [
  "idx_zero_workflow_automations_next_run",
  "idx_zero_workflow_automations_org",
  "idx_zero_workflow_automations_workflow",
  "idx_zero_workflow_github_processed_automation_delivery",
  "idx_zero_workflow_github_processed_subject",
  "idx_zero_workflow_strapi_automations_integration",
  "idx_zero_workflow_webhook_automations_token_hash",
  "idx_zero_workflow_webhook_deliveries_automation_key",
  "idx_zero_workflow_webhook_deliveries_automation_received",
  "idx_zero_workflows_agent",
  "idx_zero_workflows_org",
  "idx_zero_workflows_org_owner",
  "idx_zero_workflows_private_owner_agent_name_unique",
  "idx_zero_workflows_public_agent_name_unique",
] as const;

const expectedCurrentExplicitIndexNames = [
  ...expectedExplicitIndexNames,
  "idx_zero_workflow_automations_official_blueprint_unique",
] as const;

const expectedForeignKeyNames = [
  "agent_runs_workflow_automation_id_zero_workflow_automations_id_fk",
  "gmail_processed_events_automation_id_zero_workflow_automations_id_fk",
  "google_calendar_processed_events_automation_id_zero_workflow_automations_id_fk",
  "google_forms_automation_cursors_automation_id_zero_workflow_automations_id_fk",
  "google_forms_processed_events_automation_id_zero_workflow_automations_id_fk",
  "google_workspace_processed_events_automation_id_zero_workflow_automations_id_fk",
  "notion_workflow_pending_events_automation_id_zero_workflow_automations_id_fk",
  "strapi_workflow_pending_events_automation_id_zero_workflow_automations_id_fk",
  "stripe_workflow_automation_health_automation_id_zero_workflow_automations_id_fk",
  "workflow_user_automation_threads_workflow_id_zero_workflows_id_fk",
  "zero_workflow_automations_workflow_id_zero_workflows_id_fk",
  "zero_workflow_github_processed_events_automation_id_zero_workflow_automations_id_fk",
  "zero_workflow_strapi_automations_automation_id_zero_workflow_automations_id_fk",
  "zero_workflow_strapi_automations_integration_id_strapi_integrations_id_fk",
  "zero_workflow_webhook_automations_automation_id_zero_workflow_automations_id_fk",
  "zero_workflow_webhook_deliveries_automation_id_zero_workflow_automations_id_fk",
  "zero_workflows_agent_id_agents_id_fk",
] as const;

const expectedCurrentForeignKeyNames = [
  ...expectedForeignKeyNames,
  "official_workflow_automation_identity_automation_fk",
  "official_workflow_automation_identity_workflow_fk",
] as const;

const expectedCheckNames = [
  "zero_workflow_automations_autonomy_budget_check",
  "zero_workflow_automations_schedule_config_check",
] as const;

const expectedCurrentCheckNames = [
  ...expectedCheckNames,
  "zero_workflow_automations_official_binding_check",
  "zero_workflows_official_installation_check",
] as const;

const expectedPrimaryKeyNames = [
  "zero_workflow_automations_pkey",
  "zero_workflow_github_processed_events_pkey",
  "zero_workflow_strapi_automations_pkey",
  "zero_workflow_webhook_automations_pkey",
  "zero_workflow_webhook_deliveries_pkey",
  "zero_workflows_pkey",
] as const;

const strapiIntegrationForeignKey =
  "zero_workflow_strapi_automations_integration_id_strapi_integrations_id_fk".slice(
    0,
    63,
  );

const supportAgentId = "00000000-0000-4000-8000-000000296351";
const supportIntegrationId = "00000000-0000-4000-8000-000000296352";
const historicalWorkflowId = "00000000-0000-4000-8000-000000296353";
const historicalAutomationId = "00000000-0000-4000-8000-000000296354";
const historicalDeliveryId = "00000000-0000-4000-8000-000000296355";
const historicalGithubEventId = "00000000-0000-4000-8000-000000296356";

interface MigrationSnapshot {
  readonly id: string;
  readonly prevId: string;
  readonly tables: Record<string, unknown>;
  readonly views: Record<string, unknown>;
  readonly [key: string]: unknown;
}

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

interface RelationIdentity {
  readonly relationAcl: string;
  readonly relationFileNode: string;
  readonly relationKind: string;
  readonly relationName: string;
  readonly relationOid: string;
  readonly relationOwner: string;
}

interface ColumnDefinition {
  readonly attnum: number;
  readonly collation: string | null;
  readonly columnName: string;
  readonly compression: string;
  readonly defaultExpression: string | null;
  readonly generated: string;
  readonly identity: string;
  readonly isNotNull: boolean;
  readonly relationName: string;
  readonly storage: string;
  readonly type: string;
}

interface IndexDefinition {
  readonly constraintName: string | null;
  readonly definition: string;
  readonly indexFileNode: string;
  readonly indexName: string;
  readonly indexOid: string;
  readonly indexOwner: string;
  readonly isPrimary: boolean;
  readonly isReady: boolean;
  readonly isUnique: boolean;
  readonly isValid: boolean;
  readonly predicate: string | null;
  readonly relationName: string;
  readonly relationOid: string;
  readonly relationOwner: string;
}

interface ForeignKeyDefinition {
  readonly constraintName: string;
  readonly constraintOid: string;
  readonly definition: string;
  readonly deleteAction: string;
  readonly isDeferred: boolean;
  readonly isDeferrable: boolean;
  readonly isValidated: boolean;
  readonly matchType: string;
  readonly referencedRelationName: string;
  readonly referencedRelationOid: string;
  readonly referencedRelationOwner: string;
  readonly relationName: string;
  readonly relationOid: string;
  readonly relationOwner: string;
  readonly updateAction: string;
}

interface CheckDefinition {
  readonly checkName: string;
  readonly checkOid: string;
  readonly definition: string;
  readonly isNoInherit: boolean;
  readonly isValidated: boolean;
  readonly relationName: string;
  readonly relationOid: string;
  readonly relationOwner: string;
}

interface PhysicalCatalog {
  readonly checks: CheckDefinition[];
  readonly columns: ColumnDefinition[];
  readonly foreignKeys: ForeignKeyDefinition[];
  readonly indexes: IndexDefinition[];
  readonly relations: RelationIdentity[];
  readonly sequences: RelationIdentity[];
}

interface BehaviorFixture {
  readonly automationId: string;
  readonly deliveryId: string;
  readonly githubEventId: string;
  readonly workflowId: string;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function databaseErrorConstraint(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("constraint" in error)) {
    return undefined;
  }
  return typeof error.constraint === "string" ? error.constraint : undefined;
}

async function expectDatabaseFailure(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return databaseErrorCode(error) === code;
  });
}

async function expectUniqueViolation(
  operation: Promise<unknown>,
  constraint: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return (
      databaseErrorCode(error) === "23505" &&
      databaseErrorConstraint(error) === constraint
    );
  });
}

async function expectCheckViolation(
  operation: Promise<unknown>,
  constraint: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return (
      databaseErrorCode(error) === "23514" &&
      databaseErrorConstraint(error) === constraint
    );
  });
}

async function expectRestrictViolation(
  client: Client,
  operation: () => Promise<unknown>,
): Promise<void> {
  const serverVersionNumber = Number(
    (
      await client.query<{ serverVersionNumber: string }>(
        `
          SELECT current_setting('server_version_num') AS "serverVersionNumber"
        `,
      )
    ).rows[0]?.serverVersionNumber,
  );
  assert.ok(Number.isInteger(serverVersionNumber));

  // PostgreSQL 18 reports RESTRICT violations as 23001; older supported
  // versions report the same constraint failure as 23503.
  const expectedCode = serverVersionNumber >= 180_000 ? "23001" : "23503";
  await assert.rejects(operation(), (error: unknown) => {
    return (
      databaseErrorCode(error) === expectedCode &&
      databaseErrorConstraint(error) === strapiIntegrationForeignKey
    );
  });
}

function snapshotSchema(snapshot: MigrationSnapshot): Record<string, unknown> {
  const schema: Record<string, unknown> = { ...snapshot };
  delete schema.id;
  delete schema.prevId;
  return schema;
}

function normalizedSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, " ");
}

function expectedCreateViewStatement(definition: {
  readonly canonical: string;
  readonly columns: readonly string[];
  readonly legacy: string;
}): string {
  const columns = definition.columns.map((column) => {
    return `"${column}"`;
  });
  return `CREATE VIEW "${definition.canonical}" AS SELECT ${columns.join(
    ", ",
  )} FROM "${definition.legacy}";`;
}

function expectedCreateOrReplaceViewStatement(definition: {
  readonly canonical: string;
  readonly columns: readonly string[];
  readonly legacy: string;
}): string {
  return expectedCreateViewStatement(definition).replace(
    "CREATE VIEW",
    "CREATE OR REPLACE VIEW",
  );
}

function validateMigrationJournalEntries(
  entries: readonly JournalEntry[],
): void {
  const previousPosition = entries.findIndex(({ tag }) => {
    return tag === previousMigration;
  });
  const expansionPosition = entries.findIndex(({ tag }) => {
    return tag === expansionMigration;
  });
  assert.notEqual(previousPosition, -1);
  assert.equal(expansionPosition, previousPosition + 1);

  const previousEntry = entries[previousPosition];
  const expansionEntry = entries[expansionPosition];
  assert.ok(previousEntry);
  assert.ok(expansionEntry);
  assert.equal(previousEntry.idx, 1003);
  assert.equal(expansionEntry.idx, 1004);
  assert.equal(expansionEntry.idx, previousEntry.idx + 1);
}

async function validateMigrationArtifacts(): Promise<void> {
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${expansionMigration}.sql`),
    "utf8",
  );
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map(normalizedSql)
    .filter((statement) => {
      return statement.length > 0;
    });
  assert.deepEqual(
    statements,
    historicalRelationDefinitions.map(expectedCreateViewStatement),
  );

  const previousSnapshot = JSON.parse(
    await fs.readFile(
      path.join(migrationsDirectory, "meta/1003_snapshot.json"),
      "utf8",
    ),
  ) as MigrationSnapshot;
  const expansionSnapshot = JSON.parse(
    await fs.readFile(
      path.join(migrationsDirectory, "meta/1004_snapshot.json"),
      "utf8",
    ),
  ) as MigrationSnapshot;
  assert.equal(expansionSnapshot.prevId, previousSnapshot.id);
  assert.deepEqual(
    snapshotSchema(expansionSnapshot),
    snapshotSchema(previousSnapshot),
  );
  for (const { canonical, legacy } of historicalRelationDefinitions) {
    assert.ok(`public.${legacy}` in expansionSnapshot.tables);
    assert.ok(!(`public.${canonical}` in expansionSnapshot.tables));
    assert.ok(!(`public.${canonical}` in expansionSnapshot.views));
  }

  const journal = JSON.parse(
    await fs.readFile(
      path.join(migrationsDirectory, "meta/_journal.json"),
      "utf8",
    ),
  ) as { entries: JournalEntry[] };
  validateMigrationJournalEntries(journal.entries);
  validateMigrationJournalEntries([
    { idx: 1003, tag: previousMigration },
    { idx: 1004, tag: expansionMigration },
    { idx: 1005, tag: "1005_later_migration" },
  ]);
}

async function validateRefreshMigrationArtifacts(): Promise<void> {
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${refreshMigration}.sql`),
    "utf8",
  );
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map(normalizedSql)
    .filter((statement) => {
      return statement.length > 0;
    });
  assert.equal(statements.length, 3);
  const [guard, workflowView, automationView] = statements;
  assert.ok(guard);
  assert.ok(guard.startsWith("DO $$ DECLARE"));
  assert.ok(
    guard.includes("workflow compatibility relation identity mismatch"),
  );
  assert.ok(guard.includes("workflows compatibility view shape mismatch"));
  assert.ok(
    guard.includes("workflow_automations compatibility view shape mismatch"),
  );
  assert.ok(guard.includes("expected.relation_position"));
  assert.ok(guard.includes('COLLATE "C"'));
  assert.ok(guard.includes("zero_workflows physical table shape mismatch"));
  assert.ok(
    guard.includes("zero_workflow_automations physical table shape mismatch"),
  );
  assert.deepEqual(
    [workflowView, automationView],
    relationDefinitions.slice(0, 2).map(expectedCreateOrReplaceViewStatement),
  );

  const previousSnapshot = JSON.parse(
    await fs.readFile(
      path.join(migrationsDirectory, "meta/1019_snapshot.json"),
      "utf8",
    ),
  ) as MigrationSnapshot;
  const refreshSnapshot = JSON.parse(
    await fs.readFile(
      path.join(migrationsDirectory, "meta/1020_snapshot.json"),
      "utf8",
    ),
  ) as MigrationSnapshot;
  assert.equal(refreshSnapshot.prevId, previousSnapshot.id);
  assert.deepEqual(
    snapshotSchema(refreshSnapshot),
    snapshotSchema(previousSnapshot),
  );
  for (const { canonical, legacy } of relationDefinitions) {
    assert.ok(`public.${legacy}` in refreshSnapshot.tables);
    assert.ok(!(`public.${canonical}` in refreshSnapshot.tables));
    assert.ok(!(`public.${canonical}` in refreshSnapshot.views));
  }

  const journal = JSON.parse(
    await fs.readFile(
      path.join(migrationsDirectory, "meta/_journal.json"),
      "utf8",
    ),
  ) as { entries: JournalEntry[] };
  const previousPosition = journal.entries.findIndex(({ tag }) => {
    return tag === refreshPreviousMigration;
  });
  const refreshPosition = journal.entries.findIndex(({ tag }) => {
    return tag === refreshMigration;
  });
  assert.notEqual(previousPosition, -1);
  assert.equal(refreshPosition, previousPosition + 1);
  assert.equal(journal.entries[previousPosition]?.idx, 1019);
  assert.equal(
    journal.entries[previousPosition]?.tag,
    refreshPreviousMigration,
  );
  assert.equal(journal.entries[refreshPosition]?.idx, 1020);
  assert.equal(journal.entries[refreshPosition]?.tag, refreshMigration);
}

async function readPhysicalCatalog(client: Client): Promise<PhysicalCatalog> {
  const relations = await client.query<RelationIdentity>(
    `
      SELECT
        COALESCE("pg_class"."relacl"::text, '') AS "relationAcl",
        "pg_relation_filenode"("pg_class"."oid")::text AS "relationFileNode",
        "pg_class"."relkind"::text AS "relationKind",
        "pg_class"."relname" AS "relationName",
        "pg_class"."oid"::text AS "relationOid",
        "pg_get_userbyid"("pg_class"."relowner") AS "relationOwner"
      FROM "pg_class"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      WHERE "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = ANY($1::text[])
      ORDER BY "pg_class"."relname" COLLATE "C"
    `,
    [legacyRelationNames],
  );

  const columns = await client.query<ColumnDefinition>(
    `
      SELECT
        "pg_attribute"."attnum" AS "attnum",
        "pg_collation"."collname" AS "collation",
        "pg_attribute"."attname" AS "columnName",
        "pg_attribute"."attcompression"::text AS "compression",
        "pg_get_expr"(
          "pg_attrdef"."adbin",
          "pg_attrdef"."adrelid"
        ) AS "defaultExpression",
        "pg_attribute"."attgenerated"::text AS "generated",
        "pg_attribute"."attidentity"::text AS "identity",
        "pg_attribute"."attnotnull" AS "isNotNull",
        "pg_class"."relname" AS "relationName",
        "pg_attribute"."attstorage"::text AS "storage",
        "format_type"(
          "pg_attribute"."atttypid",
          "pg_attribute"."atttypmod"
        ) AS "type"
      FROM "pg_attribute"
      INNER JOIN "pg_class"
        ON "pg_class"."oid" = "pg_attribute"."attrelid"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      LEFT JOIN "pg_attrdef"
        ON "pg_attrdef"."adrelid" = "pg_attribute"."attrelid"
        AND "pg_attrdef"."adnum" = "pg_attribute"."attnum"
      LEFT JOIN "pg_collation"
        ON "pg_collation"."oid" = "pg_attribute"."attcollation"
        AND "pg_attribute"."attcollation" <> 0
      WHERE "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = ANY($1::text[])
        AND "pg_attribute"."attnum" > 0
        AND NOT "pg_attribute"."attisdropped"
      ORDER BY
        "pg_class"."relname" COLLATE "C",
        "pg_attribute"."attnum"
    `,
    [legacyRelationNames],
  );

  const indexes = await client.query<IndexDefinition>(
    `
      SELECT
        "pg_constraint"."conname" AS "constraintName",
        "pg_get_indexdef"("pg_index"."indexrelid") AS "definition",
        "pg_relation_filenode"("index_relation"."oid")::text AS "indexFileNode",
        "index_relation"."relname" AS "indexName",
        "index_relation"."oid"::text AS "indexOid",
        "pg_get_userbyid"("index_relation"."relowner") AS "indexOwner",
        "pg_index"."indisprimary" AS "isPrimary",
        "pg_index"."indisready" AS "isReady",
        "pg_index"."indisunique" AS "isUnique",
        "pg_index"."indisvalid" AS "isValid",
        "pg_get_expr"(
          "pg_index"."indpred",
          "pg_index"."indrelid"
        ) AS "predicate",
        "table_relation"."relname" AS "relationName",
        "table_relation"."oid"::text AS "relationOid",
        "pg_get_userbyid"("table_relation"."relowner") AS "relationOwner"
      FROM "pg_index"
      INNER JOIN "pg_class" AS "index_relation"
        ON "index_relation"."oid" = "pg_index"."indexrelid"
      INNER JOIN "pg_class" AS "table_relation"
        ON "table_relation"."oid" = "pg_index"."indrelid"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "table_relation"."relnamespace"
      LEFT JOIN "pg_constraint"
        ON "pg_constraint"."conindid" = "pg_index"."indexrelid"
        AND "pg_constraint"."contype" IN ('p', 'u', 'x')
      WHERE "pg_namespace"."nspname" = 'public'
        AND "table_relation"."relname" = ANY($1::text[])
      ORDER BY "index_relation"."relname" COLLATE "C"
    `,
    [legacyRelationNames],
  );

  const foreignKeys = await client.query<ForeignKeyDefinition>(
    `
      SELECT
        "pg_constraint"."conname" AS "constraintName",
        "pg_constraint"."oid"::text AS "constraintOid",
        "pg_get_constraintdef"(
          "pg_constraint"."oid",
          true
        ) AS "definition",
        "pg_constraint"."confdeltype"::text AS "deleteAction",
        "pg_constraint"."condeferred" AS "isDeferred",
        "pg_constraint"."condeferrable" AS "isDeferrable",
        "pg_constraint"."convalidated" AS "isValidated",
        "pg_constraint"."confmatchtype"::text AS "matchType",
        "referenced_relation"."relname" AS "referencedRelationName",
        "referenced_relation"."oid"::text AS "referencedRelationOid",
        "pg_get_userbyid"(
          "referenced_relation"."relowner"
        ) AS "referencedRelationOwner",
        "source_relation"."relname" AS "relationName",
        "source_relation"."oid"::text AS "relationOid",
        "pg_get_userbyid"(
          "source_relation"."relowner"
        ) AS "relationOwner",
        "pg_constraint"."confupdtype"::text AS "updateAction"
      FROM "pg_constraint"
      INNER JOIN "pg_class" AS "source_relation"
        ON "source_relation"."oid" = "pg_constraint"."conrelid"
      INNER JOIN "pg_class" AS "referenced_relation"
        ON "referenced_relation"."oid" = "pg_constraint"."confrelid"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "source_relation"."relnamespace"
      WHERE "pg_constraint"."contype" = 'f'
        AND "pg_namespace"."nspname" = 'public'
        AND (
          "source_relation"."relname" = ANY($1::text[])
          OR "referenced_relation"."relname" = ANY($1::text[])
        )
      ORDER BY "pg_constraint"."conname" COLLATE "C"
    `,
    [legacyRelationNames],
  );

  const checks = await client.query<CheckDefinition>(
    `
      SELECT
        "pg_constraint"."conname" AS "checkName",
        "pg_constraint"."oid"::text AS "checkOid",
        "pg_get_constraintdef"(
          "pg_constraint"."oid",
          true
        ) AS "definition",
        "pg_constraint"."connoinherit" AS "isNoInherit",
        "pg_constraint"."convalidated" AS "isValidated",
        "pg_class"."relname" AS "relationName",
        "pg_class"."oid"::text AS "relationOid",
        "pg_get_userbyid"("pg_class"."relowner") AS "relationOwner"
      FROM "pg_constraint"
      INNER JOIN "pg_class"
        ON "pg_class"."oid" = "pg_constraint"."conrelid"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      WHERE "pg_constraint"."contype" = 'c'
        AND "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = ANY($1::text[])
      ORDER BY "pg_constraint"."conname" COLLATE "C"
    `,
    [legacyRelationNames],
  );

  const sequences = await client.query<RelationIdentity>(
    `
      SELECT
        COALESCE("sequence_relation"."relacl"::text, '') AS "relationAcl",
        "pg_relation_filenode"("sequence_relation"."oid")::text AS "relationFileNode",
        "sequence_relation"."relkind"::text AS "relationKind",
        "sequence_relation"."relname" AS "relationName",
        "sequence_relation"."oid"::text AS "relationOid",
        "pg_get_userbyid"(
          "sequence_relation"."relowner"
        ) AS "relationOwner"
      FROM "pg_class" AS "sequence_relation"
      INNER JOIN "pg_depend"
        ON "pg_depend"."classid" = 'pg_class'::regclass
        AND "pg_depend"."objid" = "sequence_relation"."oid"
        AND "pg_depend"."refclassid" = 'pg_class'::regclass
        AND "pg_depend"."deptype" IN ('a', 'i')
      INNER JOIN "pg_class" AS "table_relation"
        ON "table_relation"."oid" = "pg_depend"."refobjid"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "table_relation"."relnamespace"
      WHERE "sequence_relation"."relkind" = 'S'
        AND "pg_namespace"."nspname" = 'public'
        AND "table_relation"."relname" = ANY($1::text[])
      ORDER BY "sequence_relation"."relname" COLLATE "C"
    `,
    [legacyRelationNames],
  );

  return {
    checks: checks.rows,
    columns: columns.rows,
    foreignKeys: foreignKeys.rows,
    indexes: indexes.rows,
    relations: relations.rows,
    sequences: sequences.rows,
  };
}

async function readCanonicalRelationIdentities(
  client: Client,
): Promise<RelationIdentity[]> {
  const relations = await client.query<RelationIdentity>(
    `
      SELECT
        COALESCE("pg_class"."relacl"::text, '') AS "relationAcl",
        "pg_relation_filenode"("pg_class"."oid")::text AS "relationFileNode",
        "pg_class"."relkind"::text AS "relationKind",
        "pg_class"."relname" AS "relationName",
        "pg_class"."oid"::text AS "relationOid",
        "pg_get_userbyid"("pg_class"."relowner") AS "relationOwner"
      FROM "pg_class"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      WHERE "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = ANY($1::text[])
      ORDER BY "pg_class"."relname" COLLATE "C"
    `,
    [canonicalRelationNames],
  );
  return relations.rows;
}

function validateExpectedPhysicalInventory(
  catalog: PhysicalCatalog,
  expected: {
    readonly checkNames: readonly string[];
    readonly explicitIndexNames: readonly string[];
    readonly foreignKeyNames: readonly string[];
  } = {
    checkNames: expectedCheckNames,
    explicitIndexNames: expectedExplicitIndexNames,
    foreignKeyNames: expectedForeignKeyNames,
  },
): void {
  assert.deepEqual(
    catalog.relations.map(({ relationKind, relationName }) => {
      return { relationKind, relationName };
    }),
    [...legacyRelationNames].sort().map((relationName) => {
      return { relationKind: "r", relationName };
    }),
  );
  assert.ok(
    catalog.relations.every(({ relationFileNode, relationOid }) => {
      return relationFileNode.length > 0 && relationOid.length > 0;
    }),
  );

  const explicitIndexes = catalog.indexes.filter(({ constraintName }) => {
    return constraintName === null;
  });
  assert.deepEqual(
    explicitIndexes.map(({ indexName }) => {
      return indexName;
    }),
    [...expected.explicitIndexNames].sort(),
  );
  assert.equal(explicitIndexes.length, expected.explicitIndexNames.length);
  assert.ok(
    catalog.indexes.every(
      ({
        indexFileNode,
        indexOid,
        indexOwner,
        isReady,
        isValid,
        relationName,
        relationOid,
        relationOwner,
      }) => {
        return (
          indexFileNode.length > 0 &&
          indexOid.length > 0 &&
          indexOwner.length > 0 &&
          isReady &&
          isValid &&
          relationOid.length > 0 &&
          relationOwner.length > 0 &&
          legacyRelationNames.includes(
            relationName as (typeof legacyRelationNames)[number],
          )
        );
      },
    ),
  );

  const primaryIndexes = catalog.indexes.filter(({ isPrimary }) => {
    return isPrimary;
  });
  assert.deepEqual(
    primaryIndexes.map(({ indexName }) => {
      return indexName;
    }),
    [...expectedPrimaryKeyNames].sort(),
  );
  assert.equal(primaryIndexes.length, expectedPrimaryKeyNames.length);

  assert.deepEqual(
    catalog.foreignKeys.map(({ constraintName }) => {
      return constraintName;
    }),
    expected.foreignKeyNames
      .map((constraintName) => {
        return constraintName.slice(0, 63);
      })
      .sort(),
  );
  assert.equal(catalog.foreignKeys.length, expected.foreignKeyNames.length);
  assert.ok(
    catalog.foreignKeys.every(
      ({
        constraintOid,
        referencedRelationOid,
        referencedRelationOwner,
        relationOid,
        relationOwner,
      }) => {
        return (
          constraintOid.length > 0 &&
          referencedRelationOid.length > 0 &&
          referencedRelationOwner.length > 0 &&
          relationOid.length > 0 &&
          relationOwner.length > 0
        );
      },
    ),
  );
  assert.deepEqual(
    catalog.checks.map(({ checkName }) => {
      return checkName;
    }),
    [...expected.checkNames].sort(),
  );
  assert.equal(catalog.checks.length, expected.checkNames.length);
  assert.ok(
    catalog.checks.every(({ checkOid, relationOid, relationOwner }) => {
      return (
        checkOid.length > 0 &&
        relationOid.length > 0 &&
        relationOwner.length > 0
      );
    }),
  );
  assert.deepEqual(catalog.sequences, []);
}

function validateExpectedCurrentPhysicalInventory(
  catalog: PhysicalCatalog,
): void {
  validateExpectedPhysicalInventory(catalog, {
    checkNames: expectedCurrentCheckNames,
    explicitIndexNames: expectedCurrentExplicitIndexNames,
    foreignKeyNames: expectedCurrentForeignKeyNames,
  });
}

async function readRelationRows(
  client: Client,
  relationName: RelationName,
): Promise<string> {
  const rows = await client.query<{ rows: string }>(`
    SELECT COALESCE(
      jsonb_agg(
        to_jsonb("relation_row")
        ORDER BY to_jsonb("relation_row")::text COLLATE "C"
      ),
      '[]'::jsonb
    )::text AS "rows"
    FROM "${relationName}" AS "relation_row"
  `);
  assert.equal(rows.rows.length, 1);
  const [row] = rows.rows;
  assert.ok(row);
  return row.rows;
}

async function readPhysicalRows(
  client: Client,
): Promise<Record<string, string>> {
  const rows: Record<string, string> = {};
  for (const relationName of legacyRelationNames) {
    rows[relationName] = await readRelationRows(client, relationName);
  }
  return rows;
}

async function validateCompatibleReads(client: Client): Promise<void> {
  for (const { canonical, legacy } of relationDefinitions) {
    assert.equal(
      await readRelationRows(client, canonical),
      await readRelationRows(client, legacy),
    );
  }
}

async function seedPreExpansionFixtures(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agents" ("id", "org_id", "owner", "name")
      VALUES ($1, $2, $3, $4)
    `,
    [supportAgentId, "compat-org", "compat-owner", "compat-agent"],
  );
  await client.query(
    `
      INSERT INTO "strapi_integrations" (
        "id",
        "org_id",
        "created_by_user_id",
        "name",
        "base_url",
        "normalized_base_url",
        "token_hash",
        "encrypted_token",
        "secret_last_four",
        "created_at",
        "updated_at"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $5,
        $6,
        $7,
        $8,
        $9::timestamp,
        $9::timestamp
      )
    `,
    [
      supportIntegrationId,
      "compat-org",
      "compat-owner",
      "compat-strapi",
      "https://strapi.example.invalid",
      "compat-strapi-token-hash",
      "compat-strapi-encrypted-token",
      "9352",
      "2026-08-26 09:00:00",
    ],
  );
  await client.query(
    `
      INSERT INTO "zero_workflows" (
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
        "updated_at"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'private',
        $5,
        $6,
        $7,
        $8,
        $6,
        $6,
        $9::timestamp,
        $10::timestamp
      )
    `,
    [
      historicalWorkflowId,
      "compat-org",
      supportAgentId,
      "historical-workflow",
      "Historical workflow instruction",
      "compat-owner",
      "Historical workflow",
      "Historical row created before expand",
      "2026-08-26 09:01:00",
      "2026-08-26 09:02:00",
    ],
  );
  await client.query(
    `
      INSERT INTO "zero_workflow_automations" (
        "id",
        "org_id",
        "workflow_id",
        "owner_user_id",
        "kind",
        "schedule_type",
        "interval_seconds",
        "timezone",
        "enabled",
        "consecutive_failures",
        "autonomy_budget",
        "created_at",
        "updated_at"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'schedule',
        'loop',
        300,
        'UTC',
        true,
        0,
        10,
        $5::timestamp,
        $6::timestamp
      )
    `,
    [
      historicalAutomationId,
      "compat-org",
      historicalWorkflowId,
      "compat-owner",
      "2026-08-26 09:03:00",
      "2026-08-26 09:04:00",
    ],
  );
  await client.query(
    `
      INSERT INTO "zero_workflow_webhook_automations" (
        "automation_id",
        "token_hash",
        "encrypted_token",
        "encrypted_secret",
        "secret_last_four",
        "created_at",
        "updated_at"
      )
      VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7::timestamp)
    `,
    [
      historicalAutomationId,
      "historical-webhook-token-hash",
      "historical-encrypted-token",
      "historical-encrypted-secret",
      "9354",
      "2026-08-26 09:05:00",
      "2026-08-26 09:06:00",
    ],
  );
  await client.query(
    `
      INSERT INTO "zero_workflow_webhook_deliveries" (
        "id",
        "automation_id",
        "delivery_key",
        "body_sha256",
        "status",
        "received_at",
        "created_at"
      )
      VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7::timestamp)
    `,
    [
      historicalDeliveryId,
      historicalAutomationId,
      "historical-delivery-key",
      "historical-body-sha256",
      "accepted",
      "2026-08-26 09:07:00",
      "2026-08-26 09:08:00",
    ],
  );
  await client.query(
    `
      INSERT INTO "zero_workflow_github_processed_events" (
        "id",
        "automation_id",
        "github_delivery_id",
        "repo",
        "subject_type",
        "subject_number",
        "action",
        "label_name_normalized",
        "created_at"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamp)
    `,
    [
      historicalGithubEventId,
      historicalAutomationId,
      "historical-github-delivery",
      "vm0-ai/vm0",
      "issue",
      29635,
      "opened",
      "database",
      "2026-08-26 09:09:00",
    ],
  );
  await client.query(
    `
      INSERT INTO "zero_workflow_strapi_automations" (
        "automation_id",
        "integration_id",
        "created_at"
      )
      VALUES ($1, $2, $3::timestamp)
    `,
    [historicalAutomationId, supportIntegrationId, "2026-08-26 09:10:00"],
  );
}

async function validateExpandedCatalog(
  client: Client,
  definitions: readonly {
    readonly canonical: string;
    readonly columns: readonly string[];
    readonly legacy: string;
  }[] = relationDefinitions,
  allowAdditionalLegacyColumns = false,
): Promise<void> {
  const relations = await client.query<{
    relationKind: string;
    relationName: string;
  }>(
    `
      SELECT
        "pg_class"."relkind"::text AS "relationKind",
        "pg_class"."relname" AS "relationName"
      FROM "pg_class"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      WHERE "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = ANY($1::text[])
      ORDER BY "pg_class"."relname" COLLATE "C"
    `,
    [allRelationNames],
  );
  assert.deepEqual(
    relations.rows,
    [
      ...legacyRelationNames.map((relationName) => {
        return { relationKind: "r", relationName };
      }),
      ...canonicalRelationNames.map((relationName) => {
        return { relationKind: "v", relationName };
      }),
    ].sort((left, right) => {
      if (left.relationName < right.relationName) {
        return -1;
      }
      if (left.relationName > right.relationName) {
        return 1;
      }
      return 0;
    }),
  );

  for (const { canonical, columns, legacy } of definitions) {
    const viewColumns = await client.query<{
      columnName: string;
      type: string;
    }>(
      `
        SELECT
          "pg_attribute"."attname" AS "columnName",
          "format_type"(
            "pg_attribute"."atttypid",
            "pg_attribute"."atttypmod"
          ) AS "type"
        FROM "pg_attribute"
        WHERE "pg_attribute"."attrelid" = $1::regclass
          AND "pg_attribute"."attnum" > 0
          AND NOT "pg_attribute"."attisdropped"
        ORDER BY "pg_attribute"."attnum"
      `,
      [`public.${canonical}`],
    );
    assert.deepEqual(
      viewColumns.rows.map(({ columnName }) => {
        return columnName;
      }),
      columns,
    );
    const legacyColumns = await client.query<{
      columnName: string;
      type: string;
    }>(
      `
        SELECT
          "pg_attribute"."attname" AS "columnName",
          "format_type"(
            "pg_attribute"."atttypid",
            "pg_attribute"."atttypmod"
          ) AS "type"
        FROM "pg_attribute"
        WHERE "pg_attribute"."attrelid" = $1::regclass
          AND "pg_attribute"."attnum" > 0
          AND NOT "pg_attribute"."attisdropped"
        ORDER BY "pg_attribute"."attnum"
      `,
      [`public.${legacy}`],
    );
    const legacyTypes = new Map(
      legacyColumns.rows.map(({ columnName, type }) => {
        return [columnName, type];
      }),
    );
    if (!allowAdditionalLegacyColumns) {
      assert.deepEqual(
        legacyColumns.rows
          .map(({ columnName }) => {
            return columnName;
          })
          .sort(),
        [...columns].sort(),
      );
    }
    assert.deepEqual(
      viewColumns.rows,
      columns.map((columnName) => {
        return { columnName, type: legacyTypes.get(columnName) };
      }),
    );

    const viewMetadata = await client.query<{
      isInsertableInto: string;
      isUpdatable: string;
    }>(
      `
        SELECT
          "is_insertable_into" AS "isInsertableInto",
          "is_updatable" AS "isUpdatable"
        FROM "information_schema"."views"
        WHERE "table_schema" = 'public'
          AND "table_name" = $1
      `,
      [canonical],
    );
    assert.deepEqual(viewMetadata.rows, [
      { isInsertableInto: "YES", isUpdatable: "YES" },
    ]);

    const dependencies = await client.query<{ relationName: string }>(
      `
        SELECT DISTINCT
          "referenced_relation"."relname" COLLATE "C" AS "relationName"
        FROM "pg_rewrite"
        INNER JOIN "pg_depend"
          ON "pg_depend"."objid" = "pg_rewrite"."oid"
        INNER JOIN "pg_class" AS "referenced_relation"
          ON "referenced_relation"."oid" = "pg_depend"."refobjid"
        INNER JOIN "pg_namespace"
          ON "pg_namespace"."oid" = "referenced_relation"."relnamespace"
        WHERE "pg_rewrite"."ev_class" = $1::regclass
          AND "pg_namespace"."nspname" = 'public'
          AND "referenced_relation"."relkind" = 'r'
        ORDER BY "relationName"
      `,
      [`public.${canonical}`],
    );
    assert.deepEqual(dependencies.rows, [{ relationName: legacy }]);
  }

  const triggers = await client.query<{ triggerName: string }>(
    `
      SELECT "pg_trigger"."tgname" AS "triggerName"
      FROM "pg_trigger"
      INNER JOIN "pg_class"
        ON "pg_class"."oid" = "pg_trigger"."tgrelid"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      WHERE "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = ANY($1::text[])
        AND NOT "pg_trigger"."tgisinternal"
    `,
    [canonicalRelationNames],
  );
  assert.deepEqual(triggers.rows, []);

  const rules = await client.query<{
    relationName: string;
    ruleName: string;
  }>(
    `
      SELECT
        "pg_class"."relname" AS "relationName",
        "pg_rewrite"."rulename" AS "ruleName"
      FROM "pg_rewrite"
      INNER JOIN "pg_class"
        ON "pg_class"."oid" = "pg_rewrite"."ev_class"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      WHERE "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = ANY($1::text[])
      ORDER BY
        "pg_class"."relname" COLLATE "C",
        "pg_rewrite"."rulename" COLLATE "C"
    `,
    [canonicalRelationNames],
  );
  assert.deepEqual(
    rules.rows,
    [...canonicalRelationNames].sort().map((relationName) => {
      return { relationName, ruleName: "_RETURN" };
    }),
  );
}

function onlyRow<T>(rows: readonly T[]): T {
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.ok(row);
  return row;
}

async function insertBehaviorFixture(client: Client): Promise<BehaviorFixture> {
  const workflow = onlyRow(
    (
      await client.query<{
        createdAt: string;
        id: string;
        updatedAt: string;
        visibility: string;
      }>(
        `
          INSERT INTO "workflows" (
            "org_id",
            "agent_id",
            "name",
            "instruction",
            "owner_user_id",
            "display_name",
            "description",
            "created_by",
            "updated_by"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $5, $5)
          RETURNING
            "id"::text AS "id",
            "visibility" AS "visibility",
            "created_at"::text AS "createdAt",
            "updated_at"::text AS "updatedAt"
        `,
        [
          "compat-dml-org",
          supportAgentId,
          "compat-dml-workflow",
          "Compatibility DML instruction",
          "compat-dml-owner",
          "Compatibility DML workflow",
          "Inserted through the canonical view",
        ],
      )
    ).rows,
  );
  assert.match(workflow.id, /^[0-9a-f-]{36}$/u);
  assert.equal(workflow.visibility, "private");
  assert.ok(workflow.createdAt.length > 0);
  assert.equal(workflow.updatedAt, workflow.createdAt);

  const automation = onlyRow(
    (
      await client.query<{
        autonomyBudget: number;
        consecutiveFailures: number;
        createdAt: string;
        enabled: boolean;
        id: string;
        timezone: string;
        updatedAt: string;
      }>(
        `
          INSERT INTO "workflow_automations" (
            "org_id",
            "workflow_id",
            "owner_user_id",
            "kind",
            "schedule_type",
            "interval_seconds"
          )
          VALUES ($1, $2, $3, 'schedule', 'loop', 120)
          RETURNING
            "id"::text AS "id",
            "timezone" AS "timezone",
            "enabled" AS "enabled",
            "consecutive_failures" AS "consecutiveFailures",
            "autonomy_budget" AS "autonomyBudget",
            "created_at"::text AS "createdAt",
            "updated_at"::text AS "updatedAt"
        `,
        ["compat-dml-org", workflow.id, "compat-dml-owner"],
      )
    ).rows,
  );
  assert.match(automation.id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(
    {
      autonomyBudget: automation.autonomyBudget,
      consecutiveFailures: automation.consecutiveFailures,
      enabled: automation.enabled,
      timezone: automation.timezone,
    },
    {
      autonomyBudget: 10,
      consecutiveFailures: 0,
      enabled: true,
      timezone: "UTC",
    },
  );
  assert.ok(automation.createdAt.length > 0);
  assert.equal(automation.updatedAt, automation.createdAt);

  const webhookAutomation = onlyRow(
    (
      await client.query<{
        automationId: string;
        createdAt: string;
        updatedAt: string;
      }>(
        `
          INSERT INTO "workflow_webhook_automations" (
            "automation_id",
            "token_hash",
            "encrypted_token",
            "encrypted_secret",
            "secret_last_four"
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING
            "automation_id"::text AS "automationId",
            "created_at"::text AS "createdAt",
            "updated_at"::text AS "updatedAt"
        `,
        [
          automation.id,
          "compat-dml-token-hash",
          "compat-dml-encrypted-token",
          "compat-dml-encrypted-secret",
          "dml1",
        ],
      )
    ).rows,
  );
  assert.equal(webhookAutomation.automationId, automation.id);
  assert.ok(webhookAutomation.createdAt.length > 0);
  assert.equal(webhookAutomation.updatedAt, webhookAutomation.createdAt);

  const webhookStorage = onlyRow(
    (
      await client.query<{
        secretMatches: boolean;
        tokenMatches: boolean;
      }>(
        `
          SELECT
            "encrypted_token" = $2 AS "tokenMatches",
            "encrypted_secret" = $3 AS "secretMatches"
          FROM "zero_workflow_webhook_automations"
          WHERE "automation_id" = $1
        `,
        [
          automation.id,
          "compat-dml-encrypted-token",
          "compat-dml-encrypted-secret",
        ],
      )
    ).rows,
  );
  assert.deepEqual(webhookStorage, {
    secretMatches: true,
    tokenMatches: true,
  });

  const delivery = onlyRow(
    (
      await client.query<{
        createdAt: string;
        id: string;
        receivedAt: string;
      }>(
        `
          INSERT INTO "workflow_webhook_deliveries" (
            "automation_id",
            "delivery_key",
            "body_sha256",
            "status"
          )
          VALUES ($1, $2, $3, 'accepted')
          RETURNING
            "id"::text AS "id",
            "received_at"::text AS "receivedAt",
            "created_at"::text AS "createdAt"
        `,
        [automation.id, "compat-dml-delivery", "compat-dml-body-sha256"],
      )
    ).rows,
  );
  assert.match(delivery.id, /^[0-9a-f-]{36}$/u);
  assert.ok(delivery.receivedAt.length > 0);
  assert.equal(delivery.createdAt, delivery.receivedAt);

  const githubEvent = onlyRow(
    (
      await client.query<{ createdAt: string; id: string }>(
        `
          INSERT INTO "workflow_github_processed_events" (
            "automation_id",
            "github_delivery_id",
            "repo",
            "subject_type",
            "subject_number",
            "action"
          )
          VALUES ($1, $2, $3, 'pull_request', 29635, 'opened')
          RETURNING
            "id"::text AS "id",
            "created_at"::text AS "createdAt"
        `,
        [automation.id, "compat-dml-github", "vm0-ai/vm0"],
      )
    ).rows,
  );
  assert.match(githubEvent.id, /^[0-9a-f-]{36}$/u);
  assert.ok(githubEvent.createdAt.length > 0);

  const strapiAutomation = onlyRow(
    (
      await client.query<{ automationId: string; createdAt: string }>(
        `
          INSERT INTO "workflow_strapi_automations" (
            "automation_id",
            "integration_id"
          )
          VALUES ($1, $2)
          RETURNING
            "automation_id"::text AS "automationId",
            "created_at"::text AS "createdAt"
        `,
        [automation.id, supportIntegrationId],
      )
    ).rows,
  );
  assert.equal(strapiAutomation.automationId, automation.id);
  assert.ok(strapiAutomation.createdAt.length > 0);

  await validateCompatibleReads(client);
  return {
    automationId: automation.id,
    deliveryId: delivery.id,
    githubEventId: githubEvent.id,
    workflowId: workflow.id,
  };
}

async function updateBehaviorFixture(
  client: Client,
  fixture: BehaviorFixture,
): Promise<void> {
  const workflow = onlyRow(
    (
      await client.query<{ id: string }>(
        `
          UPDATE "workflows"
          SET
            "instruction" = $2,
            "display_name" = $3,
            "description" = $4,
            "updated_at" = $5::timestamp
          WHERE "id" = $1
          RETURNING "id"::text AS "id"
        `,
        [
          fixture.workflowId,
          "Updated compatibility DML instruction",
          "Updated compatibility DML workflow",
          "Updated through the canonical view",
          "2026-08-26 10:01:00",
        ],
      )
    ).rows,
  );
  assert.equal(workflow.id, fixture.workflowId);

  const automation = onlyRow(
    (
      await client.query<{ id: string }>(
        `
          UPDATE "workflow_automations"
          SET
            "enabled" = false,
            "last_run_at" = $2::timestamp,
            "consecutive_failures" = 2,
            "autonomy_budget" = 8,
            "updated_at" = $3::timestamp
          WHERE "id" = $1
          RETURNING "id"::text AS "id"
        `,
        [fixture.automationId, "2026-08-26 10:02:00", "2026-08-26 10:03:00"],
      )
    ).rows,
  );
  assert.equal(automation.id, fixture.automationId);

  const webhookAutomation = onlyRow(
    (
      await client.query<{ automationId: string }>(
        `
          UPDATE "workflow_webhook_automations"
          SET
            "encrypted_token" = $2,
            "encrypted_secret" = $3,
            "secret_last_four" = $4,
            "last_received_at" = $5::timestamp,
            "updated_at" = $6::timestamp
          WHERE "automation_id" = $1
          RETURNING "automation_id"::text AS "automationId"
        `,
        [
          fixture.automationId,
          "compat-dml-updated-encrypted-token",
          "compat-dml-updated-encrypted-secret",
          "dml2",
          "2026-08-26 10:04:00",
          "2026-08-26 10:05:00",
        ],
      )
    ).rows,
  );
  assert.equal(webhookAutomation.automationId, fixture.automationId);

  const webhookStorage = onlyRow(
    (
      await client.query<{
        secretMatches: boolean;
        tokenMatches: boolean;
      }>(
        `
          SELECT
            "encrypted_token" = $2 AS "tokenMatches",
            "encrypted_secret" = $3 AS "secretMatches"
          FROM "zero_workflow_webhook_automations"
          WHERE "automation_id" = $1
        `,
        [
          fixture.automationId,
          "compat-dml-updated-encrypted-token",
          "compat-dml-updated-encrypted-secret",
        ],
      )
    ).rows,
  );
  assert.deepEqual(webhookStorage, {
    secretMatches: true,
    tokenMatches: true,
  });

  const delivery = onlyRow(
    (
      await client.query<{ id: string }>(
        `
          UPDATE "workflow_webhook_deliveries"
          SET
            "status" = 'dispatched',
            "run_id" = $2,
            "error_message" = $3
          WHERE "id" = $1
          RETURNING "id"::text AS "id"
        `,
        [
          fixture.deliveryId,
          "00000000-0000-4000-8000-000000296357",
          "fixture dispatch detail",
        ],
      )
    ).rows,
  );
  assert.equal(delivery.id, fixture.deliveryId);

  const githubEvent = onlyRow(
    (
      await client.query<{ id: string }>(
        `
          UPDATE "workflow_github_processed_events"
          SET
            "action" = 'synchronize',
            "label_name_normalized" = 'database-migration'
          WHERE "id" = $1
          RETURNING "id"::text AS "id"
        `,
        [fixture.githubEventId],
      )
    ).rows,
  );
  assert.equal(githubEvent.id, fixture.githubEventId);

  const strapiAutomation = onlyRow(
    (
      await client.query<{ automationId: string }>(
        `
          UPDATE "workflow_strapi_automations"
          SET "created_at" = $2::timestamp
          WHERE "automation_id" = $1
          RETURNING "automation_id"::text AS "automationId"
        `,
        [fixture.automationId, "2026-08-26 10:06:00"],
      )
    ).rows,
  );
  assert.equal(strapiAutomation.automationId, fixture.automationId);
  await validateCompatibleReads(client);
}

async function validateViewRowLock(
  client: Client,
  databaseUrl: string,
  lock: {
    readonly canonicalRelation: CanonicalRelationName;
    readonly keyColumn: string;
    readonly keyValue: string;
    readonly legacyRelation: LegacyRelationName;
    readonly mutableColumn: string;
  },
): Promise<void> {
  const contender = new Client({ connectionString: databaseUrl });
  await contender.connect();
  await client.query("BEGIN");
  try {
    const locked = await client.query<{ key: string }>(
      `
        SELECT "${lock.keyColumn}"::text AS "key"
        FROM "${lock.canonicalRelation}"
        WHERE "${lock.keyColumn}" = $1
        FOR UPDATE
      `,
      [lock.keyValue],
    );
    assert.deepEqual(locked.rows, [{ key: lock.keyValue }]);

    await contender.query("BEGIN");
    await contender.query("SET LOCAL lock_timeout = '100ms'");
    await expectDatabaseFailure(
      contender.query(
        `
          UPDATE "${lock.legacyRelation}"
          SET "${lock.mutableColumn}" = "${lock.mutableColumn}"
          WHERE "${lock.keyColumn}" = $1
        `,
        [lock.keyValue],
      ),
      "55P03",
    );
  } finally {
    await client.query("ROLLBACK");
    await contender.query("ROLLBACK");
    await contender.end();
  }
}

async function validateAllViewRowLocks(
  client: Client,
  databaseUrl: string,
  fixture: BehaviorFixture,
): Promise<void> {
  const locks = [
    {
      canonicalRelation: "workflows",
      keyColumn: "id",
      keyValue: fixture.workflowId,
      legacyRelation: "zero_workflows",
      mutableColumn: "description",
    },
    {
      canonicalRelation: "workflow_automations",
      keyColumn: "id",
      keyValue: fixture.automationId,
      legacyRelation: "zero_workflow_automations",
      mutableColumn: "updated_at",
    },
    {
      canonicalRelation: "workflow_webhook_automations",
      keyColumn: "automation_id",
      keyValue: fixture.automationId,
      legacyRelation: "zero_workflow_webhook_automations",
      mutableColumn: "updated_at",
    },
    {
      canonicalRelation: "workflow_webhook_deliveries",
      keyColumn: "id",
      keyValue: fixture.deliveryId,
      legacyRelation: "zero_workflow_webhook_deliveries",
      mutableColumn: "status",
    },
    {
      canonicalRelation: "workflow_github_processed_events",
      keyColumn: "id",
      keyValue: fixture.githubEventId,
      legacyRelation: "zero_workflow_github_processed_events",
      mutableColumn: "action",
    },
    {
      canonicalRelation: "workflow_strapi_automations",
      keyColumn: "automation_id",
      keyValue: fixture.automationId,
      legacyRelation: "zero_workflow_strapi_automations",
      mutableColumn: "created_at",
    },
  ] as const;
  for (const lock of locks) {
    await validateViewRowLock(client, databaseUrl, lock);
  }
}

async function deleteBehaviorFixture(
  client: Client,
  fixture: BehaviorFixture,
): Promise<void> {
  const deletedDelivery = onlyRow(
    (
      await client.query<{ id: string }>(
        `
          DELETE FROM "workflow_webhook_deliveries"
          WHERE "id" = $1
          RETURNING "id"::text AS "id"
        `,
        [fixture.deliveryId],
      )
    ).rows,
  );
  assert.equal(deletedDelivery.id, fixture.deliveryId);

  const deletedGithubEvent = onlyRow(
    (
      await client.query<{ id: string }>(
        `
          DELETE FROM "workflow_github_processed_events"
          WHERE "id" = $1
          RETURNING "id"::text AS "id"
        `,
        [fixture.githubEventId],
      )
    ).rows,
  );
  assert.equal(deletedGithubEvent.id, fixture.githubEventId);

  const deletedWebhookAutomation = onlyRow(
    (
      await client.query<{ automationId: string }>(
        `
          DELETE FROM "workflow_webhook_automations"
          WHERE "automation_id" = $1
          RETURNING "automation_id"::text AS "automationId"
        `,
        [fixture.automationId],
      )
    ).rows,
  );
  assert.equal(deletedWebhookAutomation.automationId, fixture.automationId);

  const deletedStrapiAutomation = onlyRow(
    (
      await client.query<{ automationId: string }>(
        `
          DELETE FROM "workflow_strapi_automations"
          WHERE "automation_id" = $1
          RETURNING "automation_id"::text AS "automationId"
        `,
        [fixture.automationId],
      )
    ).rows,
  );
  assert.equal(deletedStrapiAutomation.automationId, fixture.automationId);

  const deletedAutomation = onlyRow(
    (
      await client.query<{ id: string }>(
        `
          DELETE FROM "workflow_automations"
          WHERE "id" = $1
          RETURNING "id"::text AS "id"
        `,
        [fixture.automationId],
      )
    ).rows,
  );
  assert.equal(deletedAutomation.id, fixture.automationId);

  const deletedWorkflow = onlyRow(
    (
      await client.query<{ id: string }>(
        `
          DELETE FROM "workflows"
          WHERE "id" = $1
          RETURNING "id"::text AS "id"
        `,
        [fixture.workflowId],
      )
    ).rows,
  );
  assert.equal(deletedWorkflow.id, fixture.workflowId);
  await validateCompatibleReads(client);
}

async function createWorkflowAutomation(
  client: Client,
  fixture: {
    readonly automationId: string;
    readonly prefix: string;
    readonly workflowId: string;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO "workflows" (
        "id",
        "org_id",
        "agent_id",
        "name",
        "owner_user_id",
        "created_by",
        "updated_by"
      )
      VALUES ($1, $2, $3, $4, $5, $5, $5)
    `,
    [
      fixture.workflowId,
      `${fixture.prefix}-org`,
      supportAgentId,
      `${fixture.prefix}-workflow`,
      `${fixture.prefix}-owner`,
    ],
  );
  await client.query(
    `
      INSERT INTO "workflow_automations" (
        "id",
        "org_id",
        "workflow_id",
        "owner_user_id",
        "kind",
        "schedule_type",
        "interval_seconds"
      )
      VALUES ($1, $2, $3, $4, 'schedule', 'loop', 60)
    `,
    [
      fixture.automationId,
      `${fixture.prefix}-org`,
      fixture.workflowId,
      `${fixture.prefix}-owner`,
    ],
  );
}

async function assertClusterRowsAbsent(
  client: Client,
  fixture: { readonly automationId: string; readonly workflowId: string },
): Promise<void> {
  const counts = onlyRow(
    (
      await client.query<{
        automations: string;
        githubEvents: string;
        strapiAutomations: string;
        webhookAutomations: string;
        webhookDeliveries: string;
        workflows: string;
      }>(
        `
          SELECT
            (
              SELECT count(*)::text
              FROM "zero_workflows"
              WHERE "id" = $1
            ) AS "workflows",
            (
              SELECT count(*)::text
              FROM "zero_workflow_automations"
              WHERE "id" = $2
            ) AS "automations",
            (
              SELECT count(*)::text
              FROM "zero_workflow_webhook_automations"
              WHERE "automation_id" = $2
            ) AS "webhookAutomations",
            (
              SELECT count(*)::text
              FROM "zero_workflow_webhook_deliveries"
              WHERE "automation_id" = $2
            ) AS "webhookDeliveries",
            (
              SELECT count(*)::text
              FROM "zero_workflow_github_processed_events"
              WHERE "automation_id" = $2
            ) AS "githubEvents",
            (
              SELECT count(*)::text
              FROM "zero_workflow_strapi_automations"
              WHERE "automation_id" = $2
            ) AS "strapiAutomations"
        `,
        [fixture.workflowId, fixture.automationId],
      )
    ).rows,
  );
  assert.deepEqual(counts, {
    automations: "0",
    githubEvents: "0",
    strapiAutomations: "0",
    webhookAutomations: "0",
    webhookDeliveries: "0",
    workflows: "0",
  });
}

async function validateConstraintAndCascadeBehavior(
  client: Client,
): Promise<void> {
  const missingParentId = "00000000-0000-4000-8000-000000296399";
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "workflows" (
          "id",
          "org_id",
          "agent_id",
          "name",
          "owner_user_id",
          "created_by",
          "updated_by"
        )
        VALUES ($1, 'missing-org', $2, 'missing-agent', 'owner', 'owner', 'owner')
      `,
      ["00000000-0000-4000-8000-000000296401", missingParentId],
    ),
    "23503",
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "workflow_automations" (
          "id",
          "org_id",
          "workflow_id",
          "owner_user_id",
          "kind",
          "schedule_type",
          "interval_seconds"
        )
        VALUES ($1, 'missing-org', $2, 'owner', 'schedule', 'loop', 60)
      `,
      ["00000000-0000-4000-8000-000000296402", missingParentId],
    ),
    "23503",
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "workflow_webhook_automations" (
          "automation_id",
          "token_hash",
          "encrypted_token",
          "encrypted_secret",
          "secret_last_four"
        )
        VALUES ($1, 'missing-token', 'encrypted-token', 'encrypted-secret', 'miss')
      `,
      [missingParentId],
    ),
    "23503",
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "workflow_webhook_deliveries" (
          "automation_id",
          "delivery_key",
          "body_sha256",
          "status"
        )
        VALUES ($1, 'missing-delivery', 'missing-body', 'accepted')
      `,
      [missingParentId],
    ),
    "23503",
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "workflow_github_processed_events" (
          "automation_id",
          "github_delivery_id",
          "repo",
          "action"
        )
        VALUES ($1, 'missing-github', 'vm0-ai/vm0', 'opened')
      `,
      [missingParentId],
    ),
    "23503",
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "workflow_strapi_automations" (
          "automation_id",
          "integration_id"
        )
        VALUES ($1, $2)
      `,
      [missingParentId, supportIntegrationId],
    ),
    "23503",
  );

  const workflowId = "00000000-0000-4000-8000-000000296410";
  const automationId = "00000000-0000-4000-8000-000000296411";
  const secondAutomationId = "00000000-0000-4000-8000-000000296412";
  await createWorkflowAutomation(client, {
    automationId,
    prefix: "compat-constraints",
    workflowId,
  });
  await client.query(
    `
      INSERT INTO "workflow_automations" (
        "id",
        "org_id",
        "workflow_id",
        "owner_user_id",
        "kind",
        "schedule_type",
        "interval_seconds"
      )
      VALUES ($1, $2, $3, $4, 'schedule', 'loop', 60)
    `,
    [
      secondAutomationId,
      "compat-constraints-org",
      workflowId,
      "compat-constraints-owner",
    ],
  );

  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "workflow_automations" (
          "id",
          "org_id",
          "workflow_id",
          "owner_user_id",
          "kind"
        )
        VALUES ($1, $2, $3, $4, 'schedule')
      `,
      [
        "00000000-0000-4000-8000-000000296413",
        "compat-constraints-org",
        workflowId,
        "compat-constraints-owner",
      ],
    ),
    "23514",
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "workflow_automations" (
          "id",
          "org_id",
          "workflow_id",
          "owner_user_id",
          "kind",
          "schedule_type",
          "interval_seconds",
          "autonomy_budget"
        )
        VALUES ($1, $2, $3, $4, 'schedule', 'loop', 60, 11)
      `,
      [
        "00000000-0000-4000-8000-000000296414",
        "compat-constraints-org",
        workflowId,
        "compat-constraints-owner",
      ],
    ),
    "23514",
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "workflow_strapi_automations" (
          "automation_id",
          "integration_id"
        )
        VALUES ($1, $2)
      `,
      [automationId, missingParentId],
    ),
    "23503",
  );

  await client.query(
    `
      INSERT INTO "workflow_webhook_automations" (
        "automation_id",
        "token_hash",
        "encrypted_token",
        "encrypted_secret",
        "secret_last_four"
      )
      VALUES ($1, $2, $3, $4, 'uniq')
    `,
    [
      automationId,
      "compat-constraint-token-hash",
      "compat-constraint-encrypted-token",
      "compat-constraint-encrypted-secret",
    ],
  );
  await expectUniqueViolation(
    client.query(
      `
        INSERT INTO "workflow_webhook_automations" (
          "automation_id",
          "token_hash",
          "encrypted_token",
          "encrypted_secret",
          "secret_last_four"
        )
        VALUES ($1, $2, $3, $4, 'uniq')
      `,
      [
        secondAutomationId,
        "compat-constraint-token-hash",
        "compat-constraint-second-encrypted-token",
        "compat-constraint-second-encrypted-secret",
      ],
    ),
    "idx_zero_workflow_webhook_automations_token_hash",
  );
  await client.query(
    `
      INSERT INTO "workflow_webhook_deliveries" (
        "id",
        "automation_id",
        "delivery_key",
        "body_sha256",
        "status"
      )
      VALUES ($1, $2, 'cascade-delivery', 'cascade-body', 'accepted')
    `,
    ["00000000-0000-4000-8000-000000296415", automationId],
  );
  await client.query(
    `
      INSERT INTO "workflow_github_processed_events" (
        "id",
        "automation_id",
        "github_delivery_id",
        "repo",
        "action"
      )
      VALUES ($1, $2, 'cascade-github', 'vm0-ai/vm0', 'opened')
    `,
    ["00000000-0000-4000-8000-000000296416", automationId],
  );
  await client.query(
    `
      INSERT INTO "workflow_strapi_automations" (
        "automation_id",
        "integration_id"
      )
      VALUES ($1, $2)
    `,
    [automationId, supportIntegrationId],
  );
  await expectRestrictViolation(client, () => {
    return client.query(
      `
        DELETE FROM "strapi_integrations"
        WHERE "id" = $1
      `,
      [supportIntegrationId],
    );
  });

  const publicWorkflowId = "00000000-0000-4000-8000-000000296420";
  await client.query(
    `
      INSERT INTO "workflows" (
        "id",
        "org_id",
        "agent_id",
        "name",
        "visibility",
        "owner_user_id",
        "created_by",
        "updated_by"
      )
      VALUES ($1, 'compat-unique-org', $2, 'public-name', 'public', 'owner', 'owner', 'owner')
    `,
    [publicWorkflowId, supportAgentId],
  );
  await expectUniqueViolation(
    client.query(
      `
        INSERT INTO "workflows" (
          "id",
          "org_id",
          "agent_id",
          "name",
          "visibility",
          "owner_user_id",
          "created_by",
          "updated_by"
        )
        VALUES ($1, 'compat-unique-org', $2, 'public-name', 'public', 'other-owner', 'other-owner', 'other-owner')
      `,
      ["00000000-0000-4000-8000-000000296421", supportAgentId],
    ),
    "idx_zero_workflows_public_agent_name_unique",
  );

  const privateWorkflowId = "00000000-0000-4000-8000-000000296422";
  await client.query(
    `
      INSERT INTO "workflows" (
        "id",
        "org_id",
        "agent_id",
        "name",
        "visibility",
        "owner_user_id",
        "created_by",
        "updated_by"
      )
      VALUES ($1, 'compat-unique-org', $2, 'private-name', 'private', 'owner', 'owner', 'owner')
    `,
    [privateWorkflowId, supportAgentId],
  );
  await expectUniqueViolation(
    client.query(
      `
        INSERT INTO "workflows" (
          "id",
          "org_id",
          "agent_id",
          "name",
          "visibility",
          "owner_user_id",
          "created_by",
          "updated_by"
        )
        VALUES ($1, 'compat-unique-org', $2, 'private-name', 'private', 'owner', 'owner', 'owner')
      `,
      ["00000000-0000-4000-8000-000000296423", supportAgentId],
    ),
    "idx_zero_workflows_private_owner_agent_name_unique",
  );

  await client.query(`DELETE FROM "workflows" WHERE "id" IN ($1, $2)`, [
    publicWorkflowId,
    privateWorkflowId,
  ]);
  const deletedParent = onlyRow(
    (
      await client.query<{ id: string }>(
        `
          DELETE FROM "workflows"
          WHERE "id" = $1
          RETURNING "id"::text AS "id"
        `,
        [workflowId],
      )
    ).rows,
  );
  assert.equal(deletedParent.id, workflowId);
  await assertClusterRowsAbsent(client, { automationId, workflowId });
}

async function raceUniqueInsert(
  databaseUrl: string,
  sql: string,
  values: readonly string[],
  expectedConstraint: string,
): Promise<void> {
  const writers = [
    new Client({ connectionString: databaseUrl }),
    new Client({ connectionString: databaseUrl }),
  ];
  await Promise.all(
    writers.map(async (writer) => {
      await writer.connect();
    }),
  );
  try {
    const results = await Promise.allSettled(
      writers.map(async (writer) => {
        await writer.query(sql, [...values]);
      }),
    );
    const successes = results.filter(({ status }) => {
      return status === "fulfilled";
    });
    const failures = results.filter((result) => {
      return result.status === "rejected";
    });
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    const [failure] = failures;
    assert.ok(failure);
    assert.equal(databaseErrorCode(failure.reason), "23505");
    assert.equal(databaseErrorConstraint(failure.reason), expectedConstraint);
  } finally {
    await Promise.all(
      writers.map(async (writer) => {
        await writer.end();
      }),
    );
  }
}

async function validateDedupeArbitration(
  client: Client,
  databaseUrl: string,
): Promise<void> {
  const workflowId = "00000000-0000-4000-8000-000000296430";
  const automationId = "00000000-0000-4000-8000-000000296431";
  await createWorkflowAutomation(client, {
    automationId,
    prefix: "compat-dedupe",
    workflowId,
  });

  await client.query(
    `
      INSERT INTO "workflow_webhook_deliveries" (
        "automation_id",
        "delivery_key",
        "body_sha256",
        "status"
      )
      VALUES ($1, 'sequential-delivery', 'sequential-body', 'accepted')
    `,
    [automationId],
  );
  await expectUniqueViolation(
    client.query(
      `
        INSERT INTO "workflow_webhook_deliveries" (
          "automation_id",
          "delivery_key",
          "body_sha256",
          "status"
        )
        VALUES ($1, 'sequential-delivery', 'sequential-body', 'accepted')
      `,
      [automationId],
    ),
    "idx_zero_workflow_webhook_deliveries_automation_key",
  );

  await client.query(
    `
      INSERT INTO "workflow_github_processed_events" (
        "automation_id",
        "github_delivery_id",
        "repo",
        "action"
      )
      VALUES ($1, 'sequential-github', 'vm0-ai/vm0', 'opened')
    `,
    [automationId],
  );
  await expectUniqueViolation(
    client.query(
      `
        INSERT INTO "workflow_github_processed_events" (
          "automation_id",
          "github_delivery_id",
          "repo",
          "action"
        )
        VALUES ($1, 'sequential-github', 'vm0-ai/vm0', 'opened')
      `,
      [automationId],
    ),
    "idx_zero_workflow_github_processed_automation_delivery",
  );

  await raceUniqueInsert(
    databaseUrl,
    `
      INSERT INTO "workflow_webhook_deliveries" (
        "automation_id",
        "delivery_key",
        "body_sha256",
        "status"
      )
      VALUES ($1, 'concurrent-delivery', 'concurrent-body', 'accepted')
    `,
    [automationId],
    "idx_zero_workflow_webhook_deliveries_automation_key",
  );
  await raceUniqueInsert(
    databaseUrl,
    `
      INSERT INTO "workflow_github_processed_events" (
        "automation_id",
        "github_delivery_id",
        "repo",
        "action"
      )
      VALUES ($1, 'concurrent-github', 'vm0-ai/vm0', 'opened')
    `,
    [automationId],
    "idx_zero_workflow_github_processed_automation_delivery",
  );

  await client.query(`DELETE FROM "workflows" WHERE "id" = $1`, [workflowId]);
  await assertClusterRowsAbsent(client, { automationId, workflowId });
}

async function validateTransactionRollback(client: Client): Promise<void> {
  const workflowId = "00000000-0000-4000-8000-000000296440";
  const automationId = "00000000-0000-4000-8000-000000296441";
  await client.query("BEGIN");
  try {
    await createWorkflowAutomation(client, {
      automationId,
      prefix: "compat-rollback",
      workflowId,
    });
    await client.query(
      `
        INSERT INTO "workflow_webhook_automations" (
          "automation_id",
          "token_hash",
          "encrypted_token",
          "encrypted_secret",
          "secret_last_four"
        )
        VALUES ($1, $2, $3, $4, 'roll')
      `,
      [
        automationId,
        "compat-rollback-token-hash",
        "compat-rollback-encrypted-token",
        "compat-rollback-encrypted-secret",
      ],
    );
    await client.query(
      `
        INSERT INTO "workflow_webhook_deliveries" (
          "automation_id",
          "delivery_key",
          "body_sha256",
          "status"
        )
        VALUES ($1, 'rollback-delivery', 'rollback-body', 'accepted')
      `,
      [automationId],
    );
    await client.query(
      `
        INSERT INTO "workflow_github_processed_events" (
          "automation_id",
          "github_delivery_id",
          "repo",
          "action"
        )
        VALUES ($1, 'rollback-github', 'vm0-ai/vm0', 'opened')
      `,
      [automationId],
    );
    await client.query(
      `
        INSERT INTO "workflow_strapi_automations" (
          "automation_id",
          "integration_id"
        )
        VALUES ($1, $2)
      `,
      [automationId, supportIntegrationId],
    );
    await validateCompatibleReads(client);
  } finally {
    await client.query("ROLLBACK");
  }
  await assertClusterRowsAbsent(client, { automationId, workflowId });
}

async function validateRefreshGuardFailure(client: Client): Promise<void> {
  await client.query(
    `ALTER VIEW "workflows" RENAME COLUMN "description" TO "unexpected_description"`,
  );
  try {
    await assert.rejects(
      applyMigrationsFromDirectoryUpToTag(
        client,
        migrationsDirectory,
        refreshMigration,
      ),
      /workflows compatibility view shape mismatch/u,
    );
  } finally {
    await client.query(
      `ALTER VIEW "workflows" RENAME COLUMN "unexpected_description" TO "description"`,
    );
  }
  const applied = await client.query<{ count: string }>(
    `
      SELECT count(*)::text AS "count"
      FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = $1
    `,
    [refreshMigration],
  );
  assert.deepEqual(applied.rows, [{ count: "0" }]);
}

async function validateOfficialColumnBehavior(client: Client): Promise<void> {
  const workflowId = "00000000-0000-4000-8000-000000296450";
  const automationId = "00000000-0000-4000-8000-000000296451";
  const fingerprint = "a".repeat(64);
  await client.query("BEGIN");
  try {
    const workflow = onlyRow(
      (
        await client.query<{
          definitionName: string;
          installationState: string;
        }>(
          `
            INSERT INTO "workflows" (
              "id",
              "org_id",
              "agent_id",
              "name",
              "visibility",
              "owner_user_id",
              "created_by",
              "updated_by",
              "official_definition_name",
              "official_installation_state"
            )
            VALUES ($1, $2, $3, $4, 'private', $5, $5, $5, $4, 'installed')
            RETURNING
              "official_definition_name" AS "definitionName",
              "official_installation_state" AS "installationState"
          `,
          [
            workflowId,
            "compat-official-org",
            supportAgentId,
            "compat-official-workflow",
            "compat-official-owner",
          ],
        )
      ).rows,
    );
    assert.deepEqual(workflow, {
      definitionName: "compat-official-workflow",
      installationState: "installed",
    });

    const automation = onlyRow(
      (
        await client.query<{
          blueprintKey: string;
          intendedEnabled: boolean;
          resultEmailEnabled: boolean;
          status: string;
        }>(
          `
            INSERT INTO "workflow_automations" (
              "id",
              "org_id",
              "workflow_id",
              "owner_user_id",
              "kind",
              "schedule_type",
              "interval_seconds",
              "official_blueprint_key",
              "official_applied_fingerprint",
              "official_reconciliation_status",
              "official_parameter_bindings",
              "official_intended_enabled",
              "official_result_email_enabled"
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              'schedule',
              'loop',
              300,
              'daily-report',
              $5,
              'current',
              '[{"name":"recipient","value":"owner@example.invalid"}]'::jsonb,
              true,
              true
            )
            RETURNING
              "official_blueprint_key" AS "blueprintKey",
              "official_reconciliation_status" AS "status",
              "official_intended_enabled" AS "intendedEnabled",
              "official_result_email_enabled" AS "resultEmailEnabled"
          `,
          [
            automationId,
            "compat-official-org",
            workflowId,
            "compat-official-owner",
            fingerprint,
          ],
        )
      ).rows,
    );
    assert.deepEqual(automation, {
      blueprintKey: "daily-report",
      intendedEnabled: true,
      resultEmailEnabled: true,
      status: "current",
    });

    const updated = onlyRow(
      (
        await client.query<{
          intendedEnabled: boolean;
          resultEmailEnabled: boolean;
          status: string;
        }>(
          `
            UPDATE "workflow_automations"
            SET
              "official_reconciliation_status" = 'reconciling',
              "official_intended_enabled" = false,
              "official_result_email_enabled" = false
            WHERE "id" = $1
            RETURNING
              "official_reconciliation_status" AS "status",
              "official_intended_enabled" AS "intendedEnabled",
              "official_result_email_enabled" AS "resultEmailEnabled"
          `,
          [automationId],
        )
      ).rows,
    );
    assert.deepEqual(updated, {
      intendedEnabled: false,
      resultEmailEnabled: false,
      status: "reconciling",
    });
    await validateCompatibleReads(client);
  } finally {
    await client.query("ROLLBACK");
  }

  await expectCheckViolation(
    client.query(
      `
        INSERT INTO "workflows" (
          "id",
          "org_id",
          "agent_id",
          "name",
          "visibility",
          "instruction",
          "owner_user_id",
          "created_by",
          "updated_by",
          "official_definition_name",
          "official_installation_state"
        )
        VALUES (
          '00000000-0000-4000-8000-000000296452',
          'compat-invalid-official-org',
          $1,
          'compat-invalid-official-workflow',
          'private',
          'instructions are forbidden for official installations',
          'compat-owner',
          'compat-owner',
          'compat-owner',
          'compat-invalid-official-workflow',
          'installed'
        )
      `,
      [supportAgentId],
    ),
    "zero_workflows_official_installation_check",
  );
  await expectCheckViolation(
    client.query(
      `
        INSERT INTO "workflow_automations" (
          "id",
          "org_id",
          "workflow_id",
          "owner_user_id",
          "kind",
          "schedule_type",
          "interval_seconds",
          "official_blueprint_key",
          "official_applied_fingerprint",
          "official_reconciliation_status",
          "official_parameter_bindings",
          "official_intended_enabled"
        )
        VALUES (
          '00000000-0000-4000-8000-000000296453',
          'compat-invalid-official-org',
          $1,
          'compat-owner',
          'schedule',
          'loop',
          60,
          'missing-result-email-setting',
          $2,
          'current',
          '[]'::jsonb,
          true
        )
      `,
      [historicalWorkflowId, fingerprint],
    ),
    "zero_workflow_automations_official_binding_check",
  );
}

async function validateLegacyWritesAfterRefresh(client: Client): Promise<void> {
  const workflowId = "00000000-0000-4000-8000-000000296460";
  const automationId = "00000000-0000-4000-8000-000000296461";
  const deliveryId = "00000000-0000-4000-8000-000000296462";
  const githubEventId = "00000000-0000-4000-8000-000000296463";
  await client.query("BEGIN");
  try {
    await client.query(
      `
        INSERT INTO "zero_workflows" (
          "id",
          "org_id",
          "agent_id",
          "name",
          "owner_user_id",
          "created_by",
          "updated_by"
        )
        VALUES ($1, 'compat-legacy-org', $2, 'compat-legacy-workflow', 'compat-owner', 'compat-owner', 'compat-owner')
      `,
      [workflowId, supportAgentId],
    );
    await client.query(
      `
        INSERT INTO "zero_workflow_automations" (
          "id",
          "org_id",
          "workflow_id",
          "owner_user_id",
          "kind",
          "schedule_type",
          "interval_seconds"
        )
        VALUES ($1, 'compat-legacy-org', $2, 'compat-owner', 'schedule', 'loop', 60)
      `,
      [automationId, workflowId],
    );
    await client.query(
      `
        INSERT INTO "zero_workflow_webhook_automations" (
          "automation_id",
          "token_hash",
          "encrypted_token",
          "encrypted_secret",
          "secret_last_four"
        )
        VALUES ($1, 'compat-legacy-token-hash', 'compat-legacy-token', 'compat-legacy-secret', 'leg1')
      `,
      [automationId],
    );
    await client.query(
      `
        INSERT INTO "zero_workflow_webhook_deliveries" (
          "id",
          "automation_id",
          "delivery_key",
          "body_sha256",
          "status"
        )
        VALUES ($1, $2, 'compat-legacy-delivery', 'compat-legacy-body', 'accepted')
      `,
      [deliveryId, automationId],
    );
    await client.query(
      `
        INSERT INTO "zero_workflow_github_processed_events" (
          "id",
          "automation_id",
          "github_delivery_id",
          "repo",
          "action"
        )
        VALUES ($1, $2, 'compat-legacy-github', 'vm0-ai/vm0', 'opened')
      `,
      [githubEventId, automationId],
    );
    await client.query(
      `
        INSERT INTO "zero_workflow_strapi_automations" (
          "automation_id",
          "integration_id"
        )
        VALUES ($1, $2)
      `,
      [automationId, supportIntegrationId],
    );
    await validateCompatibleReads(client);

    await client.query(
      `
        UPDATE "zero_workflows"
        SET "description" = 'updated through the legacy table'
        WHERE "id" = $1
      `,
      [workflowId],
    );
    await client.query(
      `
        UPDATE "zero_workflow_automations"
        SET "enabled" = false
        WHERE "id" = $1
      `,
      [automationId],
    );
    const canonical = onlyRow(
      (
        await client.query<{ description: string; enabled: boolean }>(
          `
            SELECT
              "workflows"."description" AS "description",
              "workflow_automations"."enabled" AS "enabled"
            FROM "workflows"
            INNER JOIN "workflow_automations"
              ON "workflow_automations"."workflow_id" = "workflows"."id"
            WHERE "workflows"."id" = $1
          `,
          [workflowId],
        )
      ).rows,
    );
    assert.deepEqual(canonical, {
      description: "updated through the legacy table",
      enabled: false,
    });

    await client.query(`DELETE FROM "zero_workflows" WHERE "id" = $1`, [
      workflowId,
    ]);
    await assertClusterRowsAbsent(client, { automationId, workflowId });
  } finally {
    await client.query("ROLLBACK");
  }
  await validateCompatibleReads(client);
}

async function validatePhysicalOnConflictDedupeStatements(
  client: Client,
): Promise<void> {
  const workflowId = "00000000-0000-4000-8000-000000296470";
  const automationId = "00000000-0000-4000-8000-000000296471";
  await createWorkflowAutomation(client, {
    automationId,
    prefix: "compat-physical-dedupe",
    workflowId,
  });
  try {
    const webhookSql = `
      INSERT INTO "zero_workflow_webhook_deliveries" (
        "automation_id",
        "delivery_key",
        "body_sha256",
        "status",
        "received_at",
        "created_at"
      )
      VALUES ($1, $2, $3, 'accepted', $4::timestamp, $4::timestamp)
      ON CONFLICT DO NOTHING
      RETURNING "id"::text AS "id"
    `;
    const webhookFirst = await client.query<{ id: string }>(webhookSql, [
      automationId,
      "compat-physical-webhook-delivery",
      "compat-physical-webhook-body",
      "2026-08-26 11:00:00",
    ]);
    assert.equal(webhookFirst.rows.length, 1);
    const webhookDuplicate = await client.query<{ id: string }>(webhookSql, [
      automationId,
      "compat-physical-webhook-delivery",
      "compat-physical-webhook-body",
      "2026-08-26 11:00:00",
    ]);
    assert.deepEqual(webhookDuplicate.rows, []);

    const githubEventSql = `
      INSERT INTO "zero_workflow_github_processed_events" (
        "automation_id",
        "github_delivery_id",
        "repo",
        "subject_type",
        "subject_number",
        "action",
        "label_name_normalized",
        "created_at"
      )
      VALUES ($1, $2, 'vm0-ai/vm0', 'issue', 30022, 'opened', NULL, $3::timestamp)
      ON CONFLICT DO NOTHING
      RETURNING "id"::text AS "id"
    `;
    const githubEventFirst = await client.query<{ id: string }>(
      githubEventSql,
      [automationId, "compat-physical-github-event", "2026-08-26 11:01:00"],
    );
    assert.equal(githubEventFirst.rows.length, 1);
    const githubEventDuplicate = await client.query<{ id: string }>(
      githubEventSql,
      [automationId, "compat-physical-github-event", "2026-08-26 11:01:00"],
    );
    assert.deepEqual(githubEventDuplicate.rows, []);

    const githubWorkflowRunSql = `
      INSERT INTO "zero_workflow_github_processed_events" (
        "automation_id",
        "github_delivery_id",
        "repo",
        "subject_type",
        "subject_number",
        "action",
        "label_name_normalized",
        "created_at"
      )
      VALUES ($1, $2, 'vm0-ai/vm0', NULL, NULL, 'completed', NULL, $3::timestamp)
      ON CONFLICT DO NOTHING
      RETURNING "id"::text AS "id"
    `;
    const githubWorkflowRunFirst = await client.query<{ id: string }>(
      githubWorkflowRunSql,
      [
        automationId,
        "compat-physical-github-workflow-run",
        "2026-08-26 11:02:00",
      ],
    );
    assert.equal(githubWorkflowRunFirst.rows.length, 1);
    const githubWorkflowRunDuplicate = await client.query<{ id: string }>(
      githubWorkflowRunSql,
      [
        automationId,
        "compat-physical-github-workflow-run",
        "2026-08-26 11:02:00",
      ],
    );
    assert.deepEqual(githubWorkflowRunDuplicate.rows, []);
  } finally {
    await client.query(`DELETE FROM "workflows" WHERE "id" = $1`, [workflowId]);
  }
  await assertClusterRowsAbsent(client, { automationId, workflowId });
}

async function validatePreExpansionCatalog(client: Client): Promise<void> {
  const relations = await client.query<{
    relationKind: string;
    relationName: string;
  }>(
    `
      SELECT
        "pg_class"."relkind"::text AS "relationKind",
        "pg_class"."relname" AS "relationName"
      FROM "pg_class"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      WHERE "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = ANY($1::text[])
      ORDER BY "pg_class"."relname" COLLATE "C"
    `,
    [allRelationNames],
  );
  assert.deepEqual(
    relations.rows,
    [...legacyRelationNames].sort().map((relationName) => {
      return { relationKind: "r", relationName };
    }),
  );
}

export async function validateWorkflowCompatibilityViews(): Promise<void> {
  console.log("=== Validate Workflow compatibility views ===\n");

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;

  await validateMigrationArtifacts();
  await validateRefreshMigrationArtifacts();

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);

  const client = new Client({ connectionString: testUrl.toString() });
  await client.connect();
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    await validatePreExpansionCatalog(client);
    await seedPreExpansionFixtures(client);

    const physicalCatalogBefore = await readPhysicalCatalog(client);
    validateExpectedPhysicalInventory(physicalCatalogBefore);
    const physicalRowsBefore = await readPhysicalRows(client);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      expansionMigration,
    );
    await validateExpandedCatalog(client, historicalRelationDefinitions);

    const physicalCatalogAfter = await readPhysicalCatalog(client);
    validateExpectedPhysicalInventory(physicalCatalogAfter);
    assert.deepEqual(physicalCatalogAfter, physicalCatalogBefore);
    assert.deepEqual(await readPhysicalRows(client), physicalRowsBefore);
    await validateCompatibleReads(client);

    const behaviorFixture = await insertBehaviorFixture(client);
    await updateBehaviorFixture(client, behaviorFixture);
    await validateAllViewRowLocks(client, testUrl.toString(), behaviorFixture);
    await deleteBehaviorFixture(client, behaviorFixture);

    await validateConstraintAndCascadeBehavior(client);
    await validateDedupeArbitration(client, testUrl.toString());
    await validateTransactionRollback(client);
    await validateCompatibleReads(client);
    assert.deepEqual(await readPhysicalRows(client), physicalRowsBefore);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      refreshPreviousMigration,
    );
    await validateExpandedCatalog(client, historicalRelationDefinitions, true);

    await client.query(
      `
        GRANT SELECT, INSERT, UPDATE, DELETE
        ON "workflows", "workflow_automations"
        TO PUBLIC
      `,
    );
    const currentViewIdentitiesBefore =
      await readCanonicalRelationIdentities(client);
    assert.equal(currentViewIdentitiesBefore.length, 6);
    assert.ok(
      currentViewIdentitiesBefore.every(
        ({ relationKind, relationOid, relationOwner }) => {
          return (
            relationKind === "v" &&
            relationOid.length > 0 &&
            relationOwner.length > 0
          );
        },
      ),
    );
    assert.ok(
      currentViewIdentitiesBefore
        .filter(({ relationName }) => {
          return ["workflows", "workflow_automations"].includes(relationName);
        })
        .every(({ relationAcl }) => {
          return relationAcl.includes("=arwd/");
        }),
    );

    const currentPhysicalCatalogBefore = await readPhysicalCatalog(client);
    validateExpectedCurrentPhysicalInventory(currentPhysicalCatalogBefore);
    const currentPhysicalRowsBefore = await readPhysicalRows(client);

    await validateRefreshGuardFailure(client);
    await validateExpandedCatalog(client, historicalRelationDefinitions, true);
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      refreshMigration,
    );
    await validateExpandedCatalog(client);

    const currentViewIdentitiesAfter =
      await readCanonicalRelationIdentities(client);
    assert.deepEqual(currentViewIdentitiesAfter, currentViewIdentitiesBefore);
    const currentPhysicalCatalogAfter = await readPhysicalCatalog(client);
    validateExpectedCurrentPhysicalInventory(currentPhysicalCatalogAfter);
    assert.deepEqual(currentPhysicalCatalogAfter, currentPhysicalCatalogBefore);
    assert.deepEqual(await readPhysicalRows(client), currentPhysicalRowsBefore);
    await validateCompatibleReads(client);

    const refreshedBehaviorFixture = await insertBehaviorFixture(client);
    await updateBehaviorFixture(client, refreshedBehaviorFixture);
    await validateAllViewRowLocks(
      client,
      testUrl.toString(),
      refreshedBehaviorFixture,
    );
    await deleteBehaviorFixture(client, refreshedBehaviorFixture);
    await validateOfficialColumnBehavior(client);
    await validateLegacyWritesAfterRefresh(client);
    await validateConstraintAndCascadeBehavior(client);
    await validateDedupeArbitration(client, testUrl.toString());
    await validatePhysicalOnConflictDedupeStatements(client);
    await validateTransactionRollback(client);
    await validateCompatibleReads(client);
    assert.deepEqual(await readPhysicalRows(client), currentPhysicalRowsBefore);

    console.log(
      "   ✅ historical 1004 coverage and exact current 1020 view shapes pass",
    );
    console.log(
      "   ✅ six physical identities, rows, defaults, indexes, PKs, FKs, checks, owners, and grants are unchanged",
    );
    console.log(
      "   ✅ canonical and legacy reads, DML, defaults, returning, locks, cascades, constraints, and rollback pass",
    );
    console.log(
      "   ✅ Official fields and three physical ON CONFLICT dedupe statements pass\n",
    );
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateWorkflowCompatibilityViews().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
