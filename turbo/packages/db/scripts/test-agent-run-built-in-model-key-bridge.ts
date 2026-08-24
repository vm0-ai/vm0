import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { logDetailRunSelection } from "../../../apps/api/src/signals/services/log-detail-run-selection";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import {
  agentRunModelKeyBackfillProcedureStatement as backfillProcedureStatement,
  agentRunModelKeyBackfillProcedureCount as backfillProcedureCount,
  validateAgentRunBuiltInModelKeyBackfillMigrationSql as validateBackfillMigrationSql,
  validateAgentRunBuiltInModelKeyBackfillLockRetryAndTimeout,
} from "./test-agent-run-built-in-model-key-backfill";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.join(scriptDirectory, "..");
const repositoryDirectory = path.resolve(packageDirectory, "../../..");
const migrationsDirectory = path.join(packageDirectory, "src/migrations");
const previousMigration = "0970_wealthy_squadron_sinister";
const expansionMigration = "0971_daily_namor";
const backfillMigration = "0973_backfill_agent_run_built_in_model_key_ids";
const upgradeDatabase = "migration_agent_run_built_in_model_key_bridge";
const metadataPresenceConstraint = "agent_runs_metadata_presence_check";
const mirrorConflictConstraint = "agent_runs_model_key_id_mirror_check";
let cachedMigrationOwnedBridgeStatements: readonly string[] | undefined;
let cachedBackfillMigrationStatements: readonly string[] | undefined;

export const AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_NAME =
  "sync_agent_run_model_key_ids_0971";
export const AGENT_RUN_MODEL_KEY_BRIDGE_TRIGGER_DEFINITION =
  "CREATE TRIGGER sync_agent_run_model_key_ids_0971 BEFORE INSERT OR UPDATE OF vm0_model_key_id, built_in_model_key_id ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION sync_agent_run_model_key_ids_0971()";
export const AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_BODY_HASH =
  "0cb34f89e8724080310d14f837a3b762";

interface ModelKeyRow {
  readonly builtInModelKeyId: string | null;
  readonly vm0ModelKeyId: string | null;
}

interface ModelKeyStorageRow extends ModelKeyRow {
  readonly id: string;
  readonly transactionId: string;
}

interface BridgeFixture {
  readonly composeId: string;
  readonly keys: {
    readonly canonicalInsert: string;
    readonly canonicalUpdate: string;
    readonly conflictCanonical: string;
    readonly conflictLegacy: string;
    readonly equalInsert: string;
    readonly historical: string;
    readonly legacyInsert: string;
    readonly legacyUpdate: string;
  };
  readonly orgId: string;
  readonly runIds: {
    readonly canonicalInsert: string;
    readonly canonicalOnlyPreflight: string;
    readonly conflictInsert: string;
    readonly dualUpdate: string;
    readonly equalInsert: string;
    readonly historical: string;
    readonly invalidLifecycle: string;
    readonly legacyInsert: string;
    readonly lifecycleNull: string;
    readonly productNull: string;
    readonly unequalPreflight: string;
  };
  readonly sessionId: string;
  readonly userId: string;
}

function createFixture(label: string): BridgeFixture {
  const identity = randomUUID();
  return {
    composeId: randomUUID(),
    keys: {
      canonicalInsert: randomUUID(),
      canonicalUpdate: randomUUID(),
      conflictCanonical: randomUUID(),
      conflictLegacy: randomUUID(),
      equalInsert: randomUUID(),
      historical: randomUUID(),
      legacyInsert: randomUUID(),
      legacyUpdate: randomUUID(),
    },
    orgId: `agent-run-model-key-${label}-org-${identity}`,
    runIds: {
      canonicalInsert: randomUUID(),
      canonicalOnlyPreflight: randomUUID(),
      conflictInsert: randomUUID(),
      dualUpdate: randomUUID(),
      equalInsert: randomUUID(),
      historical: randomUUID(),
      invalidLifecycle: randomUUID(),
      legacyInsert: randomUUID(),
      lifecycleNull: randomUUID(),
      productNull: randomUUID(),
      unequalPreflight: randomUUID(),
    },
    sessionId: randomUUID(),
    userId: `agent-run-model-key-${label}-user-${identity}`,
  };
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

async function expectDatabaseError(
  client: Client,
  args: {
    readonly code: string;
    readonly constraint: string;
    readonly query: string;
    readonly values: readonly unknown[];
  },
): Promise<void> {
  await assert.rejects(
    client.query(args.query, [...args.values]),
    (error: unknown) => {
      return (
        databaseErrorCode(error) === args.code &&
        databaseErrorConstraint(error) === args.constraint
      );
    },
  );
}

function migrationStatements(migrationSql: string): readonly string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
}

function bridgeStatements(migrationSql: string): readonly string[] {
  const statements = migrationStatements(migrationSql).filter((statement) => {
    return (
      statement.includes(
        `CREATE FUNCTION "${AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_NAME}"()`,
      ) ||
      statement.includes(
        `CREATE TRIGGER "${AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_NAME}"`,
      )
    );
  });
  assert.equal(statements.length, 2);
  return statements;
}

async function migrationOwnedBridgeStatements(): Promise<readonly string[]> {
  if (cachedMigrationOwnedBridgeStatements) {
    return cachedMigrationOwnedBridgeStatements;
  }
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${expansionMigration}.sql`),
    "utf8",
  );
  cachedMigrationOwnedBridgeStatements = bridgeStatements(migrationSql);
  return cachedMigrationOwnedBridgeStatements;
}

async function backfillMigrationStatements(): Promise<readonly string[]> {
  if (cachedBackfillMigrationStatements) {
    return cachedBackfillMigrationStatements;
  }
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${backfillMigration}.sql`),
    "utf8",
  );
  cachedBackfillMigrationStatements = migrationStatements(migrationSql);
  return cachedBackfillMigrationStatements;
}

async function executeStatements(
  client: Client,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await client.query(statement);
  }
}

function trackedFilesWithPattern(
  pattern: string,
  pathspecs: readonly string[],
): readonly string[] {
  const result = spawnSync(
    "git",
    ["grep", "-l", "-E", pattern, "--", ...pathspecs],
    {
      cwd: repositoryDirectory,
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined);
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stderr || `git grep exited with ${String(result.status)}`,
  );
  return result.stdout
    .split("\n")
    .map((filePath) => {
      return filePath.trim();
    })
    .filter((filePath) => {
      return filePath.length > 0;
    })
    .sort();
}

async function validateRuntimeCallerIsolation(): Promise<void> {
  const runtimePathspecs = [
    "turbo/apps",
    "turbo/packages/api-contracts",
    "turbo/packages/core",
    "crates",
    "e2e",
  ] as const;
  assert.deepEqual(
    trackedFilesWithPattern(
      "builtInModelKeyId|built_in_model_key_id",
      runtimePathspecs,
    ),
    [
      "turbo/apps/api/src/signals/routes/__tests__/chat-events.bdd.test.ts",
      "turbo/apps/api/src/signals/routes/__tests__/run-lifecycle.bdd.test.ts",
      "turbo/apps/api/src/signals/routes/runners.ts",
      "turbo/apps/api/src/signals/services/agent-run-create.service.ts",
      "turbo/apps/api/src/signals/services/agent-run-metadata-write.service.ts",
      "turbo/apps/api/src/test-fixtures/agent-runs.ts",
    ],
  );
  assert.deepEqual(
    trackedFilesWithPattern("vm0ModelKeyId|vm0_model_key_id", runtimePathspecs),
    [],
  );
  assert.deepEqual(
    trackedFilesWithPattern(
      "run:[[:space:]]*agentRuns|getTableColumns\\(agentRuns\\)|select\\(agentRuns\\)|returning\\(agentRuns\\)|query\\.agentRuns\\.(findFirst|findMany)",
      runtimePathspecs,
    ),
    [],
  );

  const selectionSource = await fs.readFile(
    path.join(
      repositoryDirectory,
      "turbo/apps/api/src/signals/services/log-detail-run-selection.ts",
    ),
    "utf8",
  );
  const statementStart = selectionSource.indexOf(
    "export function logDetailRunSelection() {",
  );
  const statementEnd = selectionSource.length;
  assert.ok(statementStart >= 0 && statementEnd > statementStart);
  const statementSource = selectionSource.slice(statementStart, statementEnd);
  assert.equal(statementSource.includes("vm0ModelKeyId"), false);
  assert.equal(statementSource.includes("vm0_model_key_id"), false);
  assert.equal(statementSource.includes("builtInModelKeyId"), false);
  assert.equal(statementSource.includes("built_in_model_key_id"), false);

  const logsService = await fs.readFile(
    path.join(
      repositoryDirectory,
      "turbo/apps/api/src/signals/services/logs.service.ts",
    ),
    "utf8",
  );
  assert.ok(logsService.includes("run: logDetailRunSelection()"));
  assert.equal(logsService.includes("run: agentRuns"), false);
}

function validateMigrationSql(migrationSql: string): void {
  const statements = migrationStatements(migrationSql);
  const executableSql = migrationSql.replace(/^--.*$/gmu, "");
  assert.equal(statements.length, 5);
  assert.match(
    statements[0] ?? "",
    /DROP CONSTRAINT "agent_runs_metadata_presence_check"/u,
  );
  assert.equal(
    statements[1],
    'ALTER TABLE "agent_runs" ADD COLUMN "built_in_model_key_id" uuid;',
  );
  assert.match(
    statements[2] ?? "",
    /ADD CONSTRAINT "agent_runs_metadata_presence_check" CHECK/u,
  );
  assert.match(statements[2] ?? "", /"vm0_model_key_id" IS NULL/u);
  assert.match(statements[2] ?? "", /"built_in_model_key_id" IS NULL/u);
  assert.match(
    statements[3] ?? "",
    new RegExp(
      `CREATE FUNCTION "${AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_NAME}"\\(\\)`,
      "u",
    ),
  );
  assert.match(
    statements[3] ?? "",
    /NEW\."vm0_model_key_id" IS DISTINCT FROM OLD\."vm0_model_key_id"/u,
  );
  assert.match(
    statements[3] ?? "",
    /NEW\."built_in_model_key_id" IS DISTINCT FROM OLD\."built_in_model_key_id"/u,
  );
  assert.match(
    statements[4] ?? "",
    /BEFORE INSERT OR UPDATE OF "vm0_model_key_id", "built_in_model_key_id"/u,
  );
  assert.doesNotMatch(executableSql, /^-- vm0:non-transactional$/mu);
  assert.doesNotMatch(
    executableSql,
    /ADD COLUMN "built_in_model_key_id" uuid[^;]*(?:DEFAULT|NOT NULL)/iu,
  );
  assert.doesNotMatch(executableSql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/iu);
  assert.doesNotMatch(executableSql, /\bFOREIGN KEY\b|\bREFERENCES\b/iu);
  assert.doesNotMatch(
    executableSql,
    /\b(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(?:public\.)?"agent_runs"/iu,
  );
  assert.doesNotMatch(
    executableSql,
    /DROP\s+COLUMN|RENAME\s+COLUMN|ALTER\s+COLUMN\s+"vm0_model_key_id"/iu,
  );
  assert.doesNotMatch(executableSql, /\bCOALESCE\b/iu);
}

async function seedDependencies(
  client: Client,
  fixture: BridgeFixture,
): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, $2, 'agent-run-model-key-bridge', $3)
    `,
    [fixture.composeId, fixture.userId, fixture.orgId],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      ) VALUES ($1, $2, $3, $4)
    `,
    [fixture.sessionId, fixture.userId, fixture.orgId, fixture.composeId],
  );
}

async function insertHistoricalOldOnly(
  client: Client,
  fixture: BridgeFixture,
): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt",
        "trigger_source", "autonomy_budget", "vm0_model_key_id"
      ) VALUES ($1, $2, $3, $4, 'completed', 'historical old-only row',
        'chat', 0, $5)
    `,
    [
      fixture.runIds.historical,
      fixture.userId,
      fixture.orgId,
      fixture.sessionId,
      fixture.keys.historical,
    ],
  );
}

async function insertHistoricalOldOnlyWithBridge(
  client: Client,
  fixture: BridgeFixture,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = replica");
    await insertHistoricalOldOnly(client, fixture);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function readModelKeyRow(
  client: Client,
  runId: string,
): Promise<ModelKeyRow> {
  const result = await client.query<ModelKeyRow>(
    `
      SELECT
        "vm0_model_key_id"::text AS "vm0ModelKeyId",
        "built_in_model_key_id"::text AS "builtInModelKeyId"
      FROM "agent_runs"
      WHERE "id" = $1
    `,
    [runId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function readModelKeyStorageRows(
  client: Client,
  runIds: readonly string[],
): Promise<ModelKeyStorageRow[]> {
  const result = await client.query<ModelKeyStorageRow>(
    `
      SELECT
        "id"::text AS "id",
        "vm0_model_key_id"::text AS "vm0ModelKeyId",
        "built_in_model_key_id"::text AS "builtInModelKeyId",
        "xmin"::text AS "transactionId"
      FROM "agent_runs"
      WHERE "id" = ANY($1::uuid[])
      ORDER BY "id"
    `,
    [runIds],
  );
  assert.equal(result.rows.length, runIds.length);
  return result.rows;
}

async function insertBridgeBypassedModelKeyRow(
  client: Client,
  args: {
    readonly builtInModelKeyId: string | null;
    readonly fixture: BridgeFixture;
    readonly prompt: string;
    readonly runId: string;
    readonly vm0ModelKeyId: string | null;
  },
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "session_id", "status", "prompt",
          "trigger_source", "autonomy_budget", "vm0_model_key_id",
          "built_in_model_key_id"
        ) VALUES ($1, $2, $3, $4, 'pending', $5, 'chat', 0, $6, $7)
      `,
      [
        args.runId,
        args.fixture.userId,
        args.fixture.orgId,
        args.fixture.sessionId,
        args.prompt,
        args.vm0ModelKeyId,
        args.builtInModelKeyId,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function validatePreExpandApplicationStatement(
  client: Client,
  fixture: BridgeFixture,
): Promise<void> {
  const columns = await client.query<{ columnCount: number }>(`
    SELECT count(*)::integer AS "columnCount"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'agent_runs'
      AND "column_name" = 'built_in_model_key_id'
  `);
  assert.deepEqual(columns.rows, [{ columnCount: 0 }]);

  const [result] = await drizzle(client)
    .select({ run: logDetailRunSelection() })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, fixture.runIds.historical),
        eq(agentRuns.userId, fixture.userId),
        eq(agentRuns.orgId, fixture.orgId),
      ),
    )
    .limit(1);
  assert.ok(result);
  assert.equal(result.run.id, fixture.runIds.historical);
  assert.deepEqual(Object.keys(result.run).sort(), [
    "appendSystemPrompt",
    "completedAt",
    "createdAt",
    "error",
    "id",
    "launchSnapshot",
    "prompt",
    "result",
    "startedAt",
    "status",
  ]);
  assert.equal(Reflect.has(result.run, "builtInModelKeyId"), false);
}

async function readAgentRunsRelationFileNode(client: Client): Promise<string> {
  const result = await client.query<{ fileNode: string }>(`
    SELECT "relfilenode"::text AS "fileNode"
    FROM "pg_class"
    WHERE "oid" = 'public.agent_runs'::regclass
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.fileNode;
}

async function validateBridgeCatalog(client: Client): Promise<void> {
  const column = await client.query<{
    columnDefault: string | null;
    formattedType: string;
    hasMissing: boolean;
    isGenerated: string;
    isIdentity: string;
    isNullable: string;
  }>(`
    SELECT
      "column_row"."column_default" AS "columnDefault",
      pg_catalog.format_type(
        "attribute_row"."atttypid", "attribute_row"."atttypmod"
      ) AS "formattedType",
      "attribute_row"."atthasmissing" AS "hasMissing",
      "column_row"."is_generated" AS "isGenerated",
      "column_row"."is_identity" AS "isIdentity",
      "column_row"."is_nullable" AS "isNullable"
    FROM "information_schema"."columns" AS "column_row"
    INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
      ON "attribute_row"."attrelid" = 'public.agent_runs'::regclass
      AND "attribute_row"."attname" = "column_row"."column_name"
      AND NOT "attribute_row"."attisdropped"
    WHERE "column_row"."table_schema" = 'public'
      AND "column_row"."table_name" = 'agent_runs'
      AND "column_row"."column_name" = 'built_in_model_key_id'
  `);
  assert.deepEqual(column.rows, [
    {
      columnDefault: null,
      formattedType: "uuid",
      hasMissing: false,
      isGenerated: "NEVER",
      isIdentity: "NO",
      isNullable: "YES",
    },
  ]);

  const dependencies = await client.query<{
    foreignKeyCount: number;
    indexCount: number;
  }>(`
    SELECT
      (
        SELECT count(*)::integer
        FROM "pg_catalog"."pg_constraint" AS "constraint_row"
        INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
          ON "attribute_row"."attrelid" = "constraint_row"."conrelid"
          AND "attribute_row"."attname" = 'built_in_model_key_id'
        WHERE "constraint_row"."conrelid" = 'public.agent_runs'::regclass
          AND "constraint_row"."contype" = 'f'
          AND "attribute_row"."attnum" = ANY("constraint_row"."conkey")
      ) AS "foreignKeyCount",
      (
        SELECT count(*)::integer
        FROM "pg_catalog"."pg_index" AS "index_row"
        INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
          ON "attribute_row"."attrelid" = "index_row"."indrelid"
          AND "attribute_row"."attname" = 'built_in_model_key_id'
        WHERE "index_row"."indrelid" = 'public.agent_runs'::regclass
          AND "attribute_row"."attnum" = ANY(
            "index_row"."indkey"::smallint[]
          )
      ) AS "indexCount"
  `);
  assert.deepEqual(dependencies.rows, [{ foreignKeyCount: 0, indexCount: 0 }]);

  const metadataCheck = await client.query<{
    definition: string;
    validated: boolean;
  }>(
    `
      SELECT
        pg_get_constraintdef("oid", true) AS "definition",
        "convalidated" AS "validated"
      FROM "pg_catalog"."pg_constraint"
      WHERE "conrelid" = 'public.agent_runs'::regclass
        AND "conname" = $1
    `,
    [metadataPresenceConstraint],
  );
  assert.equal(metadataCheck.rows.length, 1);
  assert.equal(metadataCheck.rows[0]?.validated, true);
  assert.ok(
    metadataCheck.rows[0]?.definition.includes("built_in_model_key_id IS NULL"),
  );
  assert.ok(
    metadataCheck.rows[0]?.definition.includes("vm0_model_key_id IS NULL"),
  );

  const trigger = await client.query<{
    definition: string;
    enabled: string;
    tableOwner: string;
  }>(
    `
      SELECT
        pg_catalog.pg_get_triggerdef("trigger_row"."oid") AS "definition",
        "trigger_row"."tgenabled" AS "enabled",
        "owner_row"."rolname" AS "tableOwner"
      FROM "pg_catalog"."pg_trigger" AS "trigger_row"
      INNER JOIN "pg_catalog"."pg_class" AS "table_row"
        ON "table_row"."oid" = "trigger_row"."tgrelid"
      INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
        ON "namespace_row"."oid" = "table_row"."relnamespace"
      INNER JOIN "pg_catalog"."pg_roles" AS "owner_row"
        ON "owner_row"."oid" = "table_row"."relowner"
      WHERE "namespace_row"."nspname" = 'public'
        AND "table_row"."relname" = 'agent_runs'
        AND "trigger_row"."tgname" = $1
        AND NOT "trigger_row"."tgisinternal"
    `,
    [AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_NAME],
  );
  assert.deepEqual(trigger.rows, [
    {
      definition: AGENT_RUN_MODEL_KEY_BRIDGE_TRIGGER_DEFINITION,
      enabled: "O",
      tableOwner: "postgres",
    },
  ]);

  const catalogFunction = await client.query<{
    body: string;
    bodyHash: string;
    functionOwner: string;
    identityArguments: string;
    language: string;
    parallel: string;
    resultType: string;
    securityDefiner: boolean;
    strict: boolean;
    volatility: string;
  }>(
    `
      SELECT
        "function_row"."prosrc" AS "body",
        pg_catalog.md5("function_row"."prosrc") AS "bodyHash",
        "owner_row"."rolname" AS "functionOwner",
        pg_catalog.pg_get_function_identity_arguments("function_row"."oid")
          AS "identityArguments",
        "language_row"."lanname" AS "language",
        "function_row"."proparallel"::text AS "parallel",
        pg_catalog.pg_get_function_result("function_row"."oid") AS "resultType",
        "function_row"."prosecdef" AS "securityDefiner",
        "function_row"."proisstrict" AS "strict",
        "function_row"."provolatile"::text AS "volatility"
      FROM "pg_catalog"."pg_proc" AS "function_row"
      INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
        ON "namespace_row"."oid" = "function_row"."pronamespace"
      INNER JOIN "pg_catalog"."pg_language" AS "language_row"
        ON "language_row"."oid" = "function_row"."prolang"
      INNER JOIN "pg_catalog"."pg_roles" AS "owner_row"
        ON "owner_row"."oid" = "function_row"."proowner"
      WHERE "namespace_row"."nspname" = 'public'
        AND "function_row"."proname" = $1
        AND pg_catalog.pg_get_function_identity_arguments("function_row"."oid") = ''
    `,
    [AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_NAME],
  );
  assert.equal(catalogFunction.rows.length, 1);
  const [functionRow] = catalogFunction.rows;
  assert.ok(functionRow);
  assert.deepEqual(
    {
      bodyHash: functionRow.bodyHash,
      functionOwner: functionRow.functionOwner,
      identityArguments: functionRow.identityArguments,
      language: functionRow.language,
      parallel: functionRow.parallel,
      resultType: functionRow.resultType,
      securityDefiner: functionRow.securityDefiner,
      strict: functionRow.strict,
      volatility: functionRow.volatility,
    },
    {
      bodyHash: AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_BODY_HASH,
      functionOwner: trigger.rows[0]?.tableOwner,
      identityArguments: "",
      language: "plpgsql",
      parallel: "u",
      resultType: "trigger",
      securityDefiner: false,
      strict: false,
      volatility: "v",
    },
  );
  assert.ok(functionRow.body.includes("IS DISTINCT FROM OLD"));
  assert.ok(functionRow.body.includes("ERRCODE = '23514'"));
  assert.ok(functionRow.body.includes("RETURN NEW"));
}

async function validateBridgeBehavior(
  client: Client,
  fixture: BridgeFixture,
): Promise<void> {
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.historical), {
    builtInModelKeyId: null,
    vm0ModelKeyId: fixture.keys.historical,
  });
  await client.query(
    `
      UPDATE "agent_runs"
      SET
        "vm0_model_key_id" = "vm0_model_key_id",
        "built_in_model_key_id" = "built_in_model_key_id"
      WHERE "id" = $1
    `,
    [fixture.runIds.historical],
  );
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.historical), {
    builtInModelKeyId: null,
    vm0ModelKeyId: fixture.keys.historical,
  });

  const legacyInsert = await client.query<{
    id: string;
    vm0ModelKeyId: string;
  }>(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt",
        "trigger_source", "autonomy_budget", "vm0_model_key_id"
      ) VALUES ($1, $2, $3, $4, 'pending', 'legacy-only insert',
        'chat', 0, $5)
      RETURNING "id"::text AS "id", "vm0_model_key_id"::text AS "vm0ModelKeyId"
    `,
    [
      fixture.runIds.legacyInsert,
      fixture.userId,
      fixture.orgId,
      fixture.sessionId,
      fixture.keys.legacyInsert,
    ],
  );
  assert.deepEqual(legacyInsert.rows, [
    {
      id: fixture.runIds.legacyInsert,
      vm0ModelKeyId: fixture.keys.legacyInsert,
    },
  ]);
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.legacyInsert), {
    builtInModelKeyId: fixture.keys.legacyInsert,
    vm0ModelKeyId: fixture.keys.legacyInsert,
  });

  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt",
        "trigger_source", "autonomy_budget", "built_in_model_key_id"
      ) VALUES ($1, $2, $3, $4, 'pending', 'canonical-only insert',
        'chat', 0, $5)
    `,
    [
      fixture.runIds.canonicalInsert,
      fixture.userId,
      fixture.orgId,
      fixture.sessionId,
      fixture.keys.canonicalInsert,
    ],
  );
  assert.deepEqual(
    await readModelKeyRow(client, fixture.runIds.canonicalInsert),
    {
      builtInModelKeyId: fixture.keys.canonicalInsert,
      vm0ModelKeyId: fixture.keys.canonicalInsert,
    },
  );

  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt",
        "trigger_source", "autonomy_budget", "vm0_model_key_id",
        "built_in_model_key_id"
      ) VALUES ($1, $2, $3, $4, 'pending', 'equal dual insert',
        'chat', 0, $5, $5)
    `,
    [
      fixture.runIds.equalInsert,
      fixture.userId,
      fixture.orgId,
      fixture.sessionId,
      fixture.keys.equalInsert,
    ],
  );
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.equalInsert), {
    builtInModelKeyId: fixture.keys.equalInsert,
    vm0ModelKeyId: fixture.keys.equalInsert,
  });

  await expectDatabaseError(client, {
    code: "23514",
    constraint: mirrorConflictConstraint,
    query: `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt",
        "trigger_source", "autonomy_budget", "vm0_model_key_id",
        "built_in_model_key_id"
      ) VALUES ($1, $2, $3, $4, 'pending', 'unequal dual insert',
        'chat', 0, $5, $6)
    `,
    values: [
      fixture.runIds.conflictInsert,
      fixture.userId,
      fixture.orgId,
      fixture.sessionId,
      fixture.keys.conflictLegacy,
      fixture.keys.conflictCanonical,
    ],
  });
  const rejectedInsert = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS "count" FROM "agent_runs" WHERE "id" = $1`,
    [fixture.runIds.conflictInsert],
  );
  assert.deepEqual(rejectedInsert.rows, [{ count: 0 }]);

  const legacyUpdate = await client.query<{ vm0ModelKeyId: string }>(
    `
      UPDATE "agent_runs"
      SET "vm0_model_key_id" = $1
      WHERE "id" = $2
      RETURNING "vm0_model_key_id"::text AS "vm0ModelKeyId"
    `,
    [fixture.keys.legacyUpdate, fixture.runIds.legacyInsert],
  );
  assert.deepEqual(legacyUpdate.rows, [
    { vm0ModelKeyId: fixture.keys.legacyUpdate },
  ]);
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.legacyInsert), {
    builtInModelKeyId: fixture.keys.legacyUpdate,
    vm0ModelKeyId: fixture.keys.legacyUpdate,
  });

  await client.query(
    `
      UPDATE "agent_runs"
      SET "built_in_model_key_id" = $1
      WHERE "id" = $2
    `,
    [fixture.keys.canonicalUpdate, fixture.runIds.canonicalInsert],
  );
  assert.deepEqual(
    await readModelKeyRow(client, fixture.runIds.canonicalInsert),
    {
      builtInModelKeyId: fixture.keys.canonicalUpdate,
      vm0ModelKeyId: fixture.keys.canonicalUpdate,
    },
  );

  await expectDatabaseError(client, {
    code: "23514",
    constraint: mirrorConflictConstraint,
    query: `
      UPDATE "agent_runs"
      SET "vm0_model_key_id" = $1, "built_in_model_key_id" = $2
      WHERE "id" = $3
    `,
    values: [
      fixture.keys.conflictLegacy,
      fixture.keys.conflictCanonical,
      fixture.runIds.equalInsert,
    ],
  });
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.equalInsert), {
    builtInModelKeyId: fixture.keys.equalInsert,
    vm0ModelKeyId: fixture.keys.equalInsert,
  });

  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt"
      ) VALUES ($1, $2, $3, $4, 'failed', 'lifecycle null/null')
    `,
    [
      fixture.runIds.lifecycleNull,
      fixture.userId,
      fixture.orgId,
      fixture.sessionId,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt",
        "trigger_source", "autonomy_budget"
      ) VALUES ($1, $2, $3, $4, 'pending', 'product null/null', 'chat', 0)
    `,
    [
      fixture.runIds.productNull,
      fixture.userId,
      fixture.orgId,
      fixture.sessionId,
    ],
  );
  assert.deepEqual(
    await readModelKeyRow(client, fixture.runIds.lifecycleNull),
    {
      builtInModelKeyId: null,
      vm0ModelKeyId: null,
    },
  );
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.productNull), {
    builtInModelKeyId: null,
    vm0ModelKeyId: null,
  });

  await client.query(
    `
      UPDATE "agent_runs"
      SET "vm0_model_key_id" = NULL, "built_in_model_key_id" = NULL
      WHERE "id" = $1
    `,
    [fixture.runIds.equalInsert],
  );
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.equalInsert), {
    builtInModelKeyId: null,
    vm0ModelKeyId: null,
  });

  await client.query(
    `
      UPDATE "agent_runs"
      SET "prompt" = "prompt" || ' unrelated update'
      WHERE "id" IN ($1, $2, $3, $4)
    `,
    [
      fixture.runIds.historical,
      fixture.runIds.legacyInsert,
      fixture.runIds.lifecycleNull,
      fixture.runIds.productNull,
    ],
  );
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.historical), {
    builtInModelKeyId: null,
    vm0ModelKeyId: fixture.keys.historical,
  });
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.legacyInsert), {
    builtInModelKeyId: fixture.keys.legacyUpdate,
    vm0ModelKeyId: fixture.keys.legacyUpdate,
  });
  assert.deepEqual(
    await readModelKeyRow(client, fixture.runIds.lifecycleNull),
    {
      builtInModelKeyId: null,
      vm0ModelKeyId: null,
    },
  );
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.productNull), {
    builtInModelKeyId: null,
    vm0ModelKeyId: null,
  });

  await expectDatabaseError(client, {
    code: "23514",
    constraint: metadataPresenceConstraint,
    query: `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt",
        "built_in_model_key_id"
      ) VALUES ($1, $2, $3, $4, 'failed', 'invalid lifecycle metadata', $5)
    `,
    values: [
      fixture.runIds.invalidLifecycle,
      fixture.userId,
      fixture.orgId,
      fixture.sessionId,
      fixture.keys.canonicalInsert,
    ],
  });
  const invalidLifecycle = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS "count" FROM "agent_runs" WHERE "id" = $1`,
    [fixture.runIds.invalidLifecycle],
  );
  assert.deepEqual(invalidLifecycle.rows, [{ count: 0 }]);

  const legacySelect = await client.query<{ vm0ModelKeyId: string }>(
    `
      SELECT "vm0_model_key_id"::text AS "vm0ModelKeyId"
      FROM "agent_runs"
      WHERE "id" = $1
    `,
    [fixture.runIds.legacyInsert],
  );
  assert.deepEqual(legacySelect.rows, [
    { vm0ModelKeyId: fixture.keys.legacyUpdate },
  ]);
}

async function cleanupFixture(
  client: Client,
  fixture: BridgeFixture,
): Promise<void> {
  await client.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
    fixture.composeId,
  ]);
}

async function bridgeObjectCount(client: Client): Promise<{
  readonly functionCount: number;
  readonly triggerCount: number;
}> {
  const result = await client.query<{
    functionCount: number;
    triggerCount: number;
  }>(
    `
      SELECT
        (
          SELECT count(*)::integer
          FROM "pg_catalog"."pg_proc" AS "function_row"
          WHERE "function_row"."pronamespace" = 'public'::regnamespace
            AND "function_row"."proname" = $1
        ) AS "functionCount",
        (
          SELECT count(*)::integer
          FROM "pg_catalog"."pg_trigger" AS "trigger_row"
          WHERE "trigger_row"."tgrelid" = 'public.agent_runs'::regclass
            AND "trigger_row"."tgname" = $1
            AND NOT "trigger_row"."tgisinternal"
        ) AS "triggerCount"
    `,
    [AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_NAME],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function readResidualShape(client: Client): Promise<{
  readonly canonicalOnly: number;
  readonly legacyOnly: number;
  readonly unequalDual: number;
}> {
  const result = await client.query<{
    canonicalOnly: number;
    legacyOnly: number;
    unequalDual: number;
  }>(`
    SELECT
      count(*) FILTER (
        WHERE "vm0_model_key_id" IS NOT NULL
          AND "built_in_model_key_id" IS NULL
      )::integer AS "legacyOnly",
      count(*) FILTER (
        WHERE "vm0_model_key_id" IS NULL
          AND "built_in_model_key_id" IS NOT NULL
      )::integer AS "canonicalOnly",
      count(*) FILTER (
        WHERE "vm0_model_key_id" IS NOT NULL
          AND "built_in_model_key_id" IS NOT NULL
          AND "vm0_model_key_id" IS DISTINCT FROM "built_in_model_key_id"
      )::integer AS "unequalDual"
    FROM "agent_runs"
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function expectBackfillFailureBeforeMutation(
  client: Client,
  args: {
    readonly expectedError: RegExp;
    readonly protectedRunId: string;
    readonly statements: readonly string[];
  },
): Promise<void> {
  const before = await readModelKeyStorageRows(client, [args.protectedRunId]);
  await assert.rejects(
    executeStatements(client, args.statements),
    args.expectedError,
  );
  await client.query("ROLLBACK");
  assert.deepEqual(
    await readModelKeyStorageRows(client, [args.protectedRunId]),
    before,
  );
  assert.equal(await backfillProcedureCount(client), 0);
}

async function validateBackfillPreflightFailures(
  client: Client,
  fixture: BridgeFixture,
  statements: readonly string[],
): Promise<void> {
  await insertBridgeBypassedModelKeyRow(client, {
    builtInModelKeyId: fixture.keys.canonicalInsert,
    fixture,
    prompt: "canonical-only preflight conflict",
    runId: fixture.runIds.canonicalOnlyPreflight,
    vm0ModelKeyId: null,
  });
  await expectBackfillFailureBeforeMutation(client, {
    expectedError: /Agent Run model key backfill found canonical-only rows/u,
    protectedRunId: fixture.runIds.historical,
    statements,
  });
  await client.query(`DELETE FROM "agent_runs" WHERE "id" = $1`, [
    fixture.runIds.canonicalOnlyPreflight,
  ]);

  await insertBridgeBypassedModelKeyRow(client, {
    builtInModelKeyId: fixture.keys.conflictCanonical,
    fixture,
    prompt: "unequal dual preflight conflict",
    runId: fixture.runIds.unequalPreflight,
    vm0ModelKeyId: fixture.keys.conflictLegacy,
  });
  await expectBackfillFailureBeforeMutation(client, {
    expectedError: /Agent Run model key backfill found unequal dual rows/u,
    protectedRunId: fixture.runIds.historical,
    statements,
  });
  await client.query(`DELETE FROM "agent_runs" WHERE "id" = $1`, [
    fixture.runIds.unequalPreflight,
  ]);

  await client.query(
    `ALTER TABLE "agent_runs" DISABLE TRIGGER "${AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_NAME}"`,
  );
  try {
    await expectBackfillFailureBeforeMutation(client, {
      expectedError:
        /Agent Run model key backfill requires the accepted enabled 0971 bridge/u,
      protectedRunId: fixture.runIds.historical,
      statements,
    });
  } finally {
    await client.query(
      `ALTER TABLE "agent_runs" ENABLE TRIGGER "${AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_NAME}"`,
    );
  }
  await validateBridgeCatalog(client);
}

function preservedBackfillRunIds(fixture: BridgeFixture): readonly string[] {
  return [
    fixture.runIds.canonicalInsert,
    fixture.runIds.equalInsert,
    fixture.runIds.legacyInsert,
    fixture.runIds.lifecycleNull,
    fixture.runIds.productNull,
  ];
}

async function validateBackfillOutcome(
  client: Client,
  fixture: BridgeFixture,
  preservedBefore: readonly ModelKeyStorageRow[],
): Promise<void> {
  assert.deepEqual(await readModelKeyRow(client, fixture.runIds.historical), {
    builtInModelKeyId: fixture.keys.historical,
    vm0ModelKeyId: fixture.keys.historical,
  });
  assert.deepEqual(
    await readModelKeyStorageRows(client, preservedBackfillRunIds(fixture)),
    preservedBefore,
  );
  assert.deepEqual(await readResidualShape(client), {
    canonicalOnly: 0,
    legacyOnly: 0,
    unequalDual: 0,
  });
  assert.equal(await backfillProcedureCount(client), 0);
  await validateBridgeCatalog(client);
}

export async function validateAgentRunBuiltInModelKeyExpansionMigration(): Promise<void> {
  console.log("=== Validate Agent Run built-in model key expansion ===\n");
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${expansionMigration}.sql`),
    "utf8",
  );
  const backfillSql = await fs.readFile(
    path.join(migrationsDirectory, `${backfillMigration}.sql`),
    "utf8",
  );
  validateMigrationSql(migrationSql);
  const backfillStatements = migrationStatements(backfillSql);
  validateBackfillMigrationSql(backfillSql, backfillStatements, {
    functionBodyHash: AGENT_RUN_MODEL_KEY_BRIDGE_FUNCTION_BODY_HASH,
    triggerDefinition: AGENT_RUN_MODEL_KEY_BRIDGE_TRIGGER_DEFINITION,
  });
  cachedMigrationOwnedBridgeStatements = bridgeStatements(migrationSql);
  cachedBackfillMigrationStatements = backfillStatements;
  await validateRuntimeCallerIsolation();

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const upgradeUrl = new URL(databaseUrl);
  upgradeUrl.pathname = `/${upgradeDatabase}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(
    `DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`,
  );
  await admin.query(`CREATE DATABASE "${upgradeDatabase}"`);

  const client = new Client({ connectionString: upgradeUrl.toString() });
  await client.connect();
  const fixture = createFixture("upgrade");
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    await seedDependencies(client, fixture);
    await insertHistoricalOldOnly(client, fixture);
    await validatePreExpandApplicationStatement(client, fixture);
    const relationFileNode = await readAgentRunsRelationFileNode(client);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      expansionMigration,
    );
    assert.equal(await readAgentRunsRelationFileNode(client), relationFileNode);
    await validateBridgeCatalog(client);
    await validateBridgeBehavior(client, fixture);

    const backfillStatements = await backfillMigrationStatements();
    await validateBackfillPreflightFailures(
      client,
      fixture,
      backfillStatements,
    );
    const preservedBefore = await readModelKeyStorageRows(
      client,
      preservedBackfillRunIds(fixture),
    );
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      backfillMigration,
    );
    await validateBackfillOutcome(client, fixture, preservedBefore);

    const postBackfillRunIds = [
      fixture.runIds.historical,
      ...preservedBackfillRunIds(fixture),
    ];
    const stateAfterFirstBackfill = await readModelKeyStorageRows(
      client,
      postBackfillRunIds,
    );
    await executeStatements(client, backfillStatements);
    assert.deepEqual(
      await readModelKeyStorageRows(client, postBackfillRunIds),
      stateAfterFirstBackfill,
    );
    await validateBackfillOutcome(client, fixture, preservedBefore);
    await validateAgentRunBuiltInModelKeyBackfillLockRetryAndTimeout(
      upgradeUrl.toString(),
      fixture,
      backfillProcedureStatement(backfillStatements),
    );
    await validateBridgeCatalog(client);

    console.log("   ✅ current logDetail statement runs on the 0970 schema");
    console.log("   ✅ nullable UUID expansion preserves historical storage");
    console.log("   ✅ historical old-only rows remain unbackfilled");
    console.log("   ✅ legacy and canonical inserts mirror bidirectionally");
    console.log("   ✅ OLD/NEW-aware updates honor the actually changed side");
    console.log("   ✅ unequal dual writes reject atomically with 23514");
    console.log("   ✅ null and metadata-presence states remain legal");
    console.log("   ✅ backfill preflight rejects conflicts before mutation");
    console.log("   ✅ historical rows backfill in an independent stage");
    console.log("   ✅ a second application performs no row updates");
    console.log("   ✅ locked rows retry or fail at the bounded timeout\n");
  } finally {
    await cleanupFixture(client, fixture);
    await client.end();
    await admin.query(
      `DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`,
    );
    await admin.end();
  }
}

export async function validateAgentRunBuiltInModelKeyBridgeSchema(
  databaseUrl: string,
  options: { readonly installMigrationOwnedBridge: boolean },
): Promise<void> {
  console.log(
    "=== Validate Agent Run built-in model key current-schema bridge ===\n",
  );
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const fixture = createFixture(
    options.installMigrationOwnedBridge ? "generated" : "replay",
  );
  try {
    if (options.installMigrationOwnedBridge) {
      assert.deepEqual(await bridgeObjectCount(client), {
        functionCount: 0,
        triggerCount: 0,
      });
      await executeStatements(client, await migrationOwnedBridgeStatements());
    }
    assert.deepEqual(await bridgeObjectCount(client), {
      functionCount: 1,
      triggerCount: 1,
    });
    await validateBridgeCatalog(client);
    await seedDependencies(client, fixture);
    await insertHistoricalOldOnlyWithBridge(client, fixture);
    await validateBridgeBehavior(client, fixture);
    const preservedBefore = await readModelKeyStorageRows(
      client,
      preservedBackfillRunIds(fixture),
    );
    await executeStatements(client, await backfillMigrationStatements());
    await validateBackfillOutcome(client, fixture, preservedBefore);
    console.log(
      "   ✅ exact column, bridge, backfill behavior, and cleanup match\n",
    );
  } finally {
    await cleanupFixture(client, fixture);
    await client.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateAgentRunBuiltInModelKeyExpansionMigration().catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
