import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.join(scriptDirectory, "..");
const repositoryDirectory = path.resolve(packageDirectory, "../../..");
const migrationsDirectory = path.join(packageDirectory, "src/migrations");
const previousMigration = "0932_lovely_red_wolf";
const launchSnapshotMigration = "0933_agent_run_launch_snapshot";
const previousV3Migration = "1067_migrate_claude_fable_5_to_5_1";
const launchSnapshotV3Migration = "1068_piloop_launch_snapshot_v3";
const constraintName = "agent_runs_launch_snapshot_check";
const v3ConstraintName = "agent_runs_launch_snapshot_v3_check";
const upgradeDatabase = "migration_agent_run_launch_snapshot";
const v3UpgradeDatabase = "migration_agent_run_launch_snapshot_v3";

const historicalLaunchSnapshotRows = [
  {
    runId: "00000000-0000-4000-8000-000000106811",
    launchSnapshot: {
      schemaVersion: 1,
      framework: "claude-code",
      runnerProfile: "vm0/v1-claude-code",
    },
  },
  {
    runId: "00000000-0000-4000-8000-000000106812",
    launchSnapshot: {
      schemaVersion: 1,
      framework: "codex",
      runnerProfile: "vm0/v1-codex",
    },
  },
  {
    runId: "00000000-0000-4000-8000-000000106813",
    launchSnapshot: {
      schemaVersion: 1,
      framework: "pi",
      runnerProfile: "vm0/v1-pi",
    },
  },
  {
    runId: "00000000-0000-4000-8000-000000106814",
    launchSnapshot: {
      schemaVersion: 2,
      framework: "claude-code",
      runnerProfile: "vm0/v2-false-claude-code",
      piMemoryGenerationEnabled: false,
    },
  },
  {
    runId: "00000000-0000-4000-8000-000000106815",
    launchSnapshot: {
      schemaVersion: 2,
      framework: "claude-code",
      runnerProfile: "vm0/v2-true-claude-code",
      piMemoryGenerationEnabled: true,
    },
  },
  {
    runId: "00000000-0000-4000-8000-000000106816",
    launchSnapshot: {
      schemaVersion: 2,
      framework: "codex",
      runnerProfile: "vm0/v2-false-codex",
      piMemoryGenerationEnabled: false,
    },
  },
  {
    runId: "00000000-0000-4000-8000-000000106817",
    launchSnapshot: {
      schemaVersion: 2,
      framework: "codex",
      runnerProfile: "vm0/v2-true-codex",
      piMemoryGenerationEnabled: true,
    },
  },
  {
    runId: "00000000-0000-4000-8000-000000106818",
    launchSnapshot: {
      schemaVersion: 2,
      framework: "pi",
      runnerProfile: "vm0/v2-false-pi",
      piMemoryGenerationEnabled: false,
    },
  },
  {
    runId: "00000000-0000-4000-8000-000000106819",
    launchSnapshot: {
      schemaVersion: 2,
      framework: "pi",
      runnerProfile: "vm0/v2-true-pi",
      piMemoryGenerationEnabled: true,
    },
  },
] as const;

interface LaunchSnapshotConstraintCatalogRow {
  readonly definition: string;
  readonly name: string;
  readonly validated: boolean;
}

interface HistoricalLaunchSnapshotStorageRow {
  readonly binaryHex: string;
  readonly ctid: string;
  readonly launchSnapshot: unknown;
  readonly launchSnapshotText: string;
  readonly runId: string;
  readonly xmin: string;
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

function migrationStatementAt(
  statements: readonly string[],
  index: number,
): string {
  const statement = statements[index];
  assert.ok(statement, `migration statement ${index + 1} is required`);
  return statement;
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

async function expectConstraintViolation(
  client: Client,
  runId: string,
  value: unknown,
): Promise<void> {
  await assert.rejects(
    client.query(
      `
        UPDATE "agent_runs"
        SET "launch_snapshot" = $1::jsonb
        WHERE "id" = $2
      `,
      [JSON.stringify(value), runId],
    ),
    (error: unknown) => {
      return (
        databaseErrorCode(error) === "23514" &&
        databaseErrorConstraint(error) === constraintName
      );
    },
  );
}

async function seedAgentRun(
  client: Client,
  fixture: {
    readonly agentId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly suffix: string;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.agentId,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch snapshot ${fixture.suffix}`,
      `launch-snapshot-${fixture.suffix}-org`,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      ) VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.sessionId,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch-snapshot-${fixture.suffix}-org`,
      fixture.agentId,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt"
      ) VALUES ($1, $2, $3, $4, 'pending', $5)
    `,
    [
      fixture.runId,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch-snapshot-${fixture.suffix}-org`,
      fixture.sessionId,
      `launch snapshot ${fixture.suffix}`,
    ],
  );
}

async function seedCanonicalAgentRun(
  client: Client,
  fixture: {
    readonly agentId: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly suffix: string;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO "agents" ("id", "org_id", "owner", "name")
      VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.agentId,
      `launch-snapshot-${fixture.suffix}-org`,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch snapshot ${fixture.suffix}`,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_id"
      ) VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.sessionId,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch-snapshot-${fixture.suffix}-org`,
      fixture.agentId,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt"
      ) VALUES ($1, $2, $3, $4, 'pending', $5)
    `,
    [
      fixture.runId,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch-snapshot-${fixture.suffix}-org`,
      fixture.sessionId,
      `launch snapshot ${fixture.suffix}`,
    ],
  );
}

async function seedHistoricalLaunchSnapshotMatrix(
  client: Client,
): Promise<void> {
  const fixture = {
    agentId: "00000000-0000-4000-8000-000000106801",
    sessionId: "00000000-0000-4000-8000-000000106802",
    suffix: "v3-upgrade",
  } as const;
  await client.query(
    `
      INSERT INTO "agents" ("id", "org_id", "owner", "name")
      VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.agentId,
      `launch-snapshot-${fixture.suffix}-org`,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch snapshot ${fixture.suffix}`,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_id"
      ) VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.sessionId,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch-snapshot-${fixture.suffix}-org`,
      fixture.agentId,
    ],
  );
  for (const row of historicalLaunchSnapshotRows) {
    await client.query(
      `
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "session_id", "status", "prompt",
          "launch_snapshot"
        ) VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb)
      `,
      [
        row.runId,
        `launch-snapshot-${fixture.suffix}-user`,
        `launch-snapshot-${fixture.suffix}-org`,
        fixture.sessionId,
        `launch snapshot ${row.runId}`,
        JSON.stringify(row.launchSnapshot),
      ],
    );
  }
}

async function readHistoricalLaunchSnapshotRows(
  client: Client,
): Promise<HistoricalLaunchSnapshotStorageRow[]> {
  const result = await client.query<HistoricalLaunchSnapshotStorageRow>(
    `
      SELECT
        "id"::text AS "runId",
        "launch_snapshot" AS "launchSnapshot",
        "launch_snapshot"::text AS "launchSnapshotText",
        encode(pg_catalog.jsonb_send("launch_snapshot"), 'hex') AS "binaryHex",
        "ctid"::text AS "ctid",
        "xmin"::text AS "xmin"
      FROM "agent_runs"
      WHERE "id" = ANY ($1::uuid[])
      ORDER BY "id"
    `,
    [
      historicalLaunchSnapshotRows.map(({ runId }) => {
        return runId;
      }),
    ],
  );
  assert.equal(result.rows.length, historicalLaunchSnapshotRows.length);
  return result.rows;
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

async function readLaunchSnapshotCatalog(client: Client): Promise<{
  readonly columnDefault: string | null;
  readonly hasMissing: boolean;
  readonly isNullable: "NO" | "YES";
  readonly type: string;
}> {
  const result = await client.query<{
    columnDefault: string | null;
    hasMissing: boolean;
    isNullable: "NO" | "YES";
    type: string;
  }>(`
    SELECT
      "column_row"."data_type" AS "type",
      "column_row"."is_nullable" AS "isNullable",
      "column_row"."column_default" AS "columnDefault",
      "attribute_row"."atthasmissing" AS "hasMissing"
    FROM "information_schema"."columns" AS "column_row"
    INNER JOIN "pg_attribute" AS "attribute_row"
      ON "attribute_row"."attrelid" = 'public.agent_runs'::regclass
      AND "attribute_row"."attname" = "column_row"."column_name"
      AND NOT "attribute_row"."attisdropped"
    WHERE "column_row"."table_schema" = 'public'
      AND "column_row"."table_name" = 'agent_runs'
      AND "column_row"."column_name" = 'launch_snapshot'
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function readConstraintCatalog(client: Client): Promise<{
  readonly definition: string;
  readonly validated: boolean;
}> {
  const result = await client.query<{
    definition: string;
    validated: boolean;
  }>(
    `
      SELECT
        pg_get_constraintdef("oid", true) AS "definition",
        "convalidated" AS "validated"
      FROM "pg_constraint"
      WHERE "conrelid" = 'public.agent_runs'::regclass
        AND "conname" = $1
    `,
    [constraintName],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function readLaunchSnapshotConstraintCatalog(
  client: Client,
): Promise<LaunchSnapshotConstraintCatalogRow[]> {
  const result = await client.query<LaunchSnapshotConstraintCatalogRow>(
    `
      SELECT
        "conname" AS "name",
        pg_get_constraintdef("oid", true) AS "definition",
        "convalidated" AS "validated"
      FROM "pg_constraint"
      WHERE "conrelid" = 'public.agent_runs'::regclass
        AND "conname" = ANY ($1::text[])
      ORDER BY "conname"
    `,
    [[constraintName, v3ConstraintName]],
  );
  return result.rows;
}

async function readTrackedMigrationCount(
  client: Client,
  migration: string,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `
      SELECT count(*)::int AS "count"
      FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = $1
    `,
    [migration],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.count;
}

async function validateConstraintValues(
  client: Client,
  runId: string,
  supportsV2: boolean,
  supportsV3: boolean,
): Promise<void> {
  await client.query(
    `UPDATE "agent_runs" SET "launch_snapshot" = NULL WHERE "id" = $1`,
    [runId],
  );

  for (const framework of ["claude-code", "codex", "pi"] as const) {
    await client.query(
      `
        UPDATE "agent_runs"
        SET "launch_snapshot" = $1::jsonb
        WHERE "id" = $2
      `,
      [
        JSON.stringify({
          schemaVersion: 1,
          framework,
          runnerProfile: "vm0/default",
        }),
        runId,
      ],
    );
  }

  if (supportsV2) {
    for (const framework of ["claude-code", "codex", "pi"] as const) {
      for (const piMemoryGenerationEnabled of [false, true]) {
        await client.query(
          `
            UPDATE "agent_runs"
            SET "launch_snapshot" = $1::jsonb
            WHERE "id" = $2
          `,
          [
            JSON.stringify({
              schemaVersion: 2,
              framework,
              runnerProfile: "vm0/default",
              piMemoryGenerationEnabled,
            }),
            runId,
          ],
        );
      }
    }
  }

  if (supportsV3) {
    for (const framework of ["claude-code", "codex", "pi"] as const) {
      await client.query(
        `
          UPDATE "agent_runs"
          SET "launch_snapshot" = $1::jsonb
          WHERE "id" = $2
        `,
        [
          JSON.stringify({
            schemaVersion: 3,
            framework,
            runnerProfile: "vm0/default",
          }),
          runId,
        ],
      );
    }
  }

  await client.query(
    `
      UPDATE "agent_runs"
      SET "launch_snapshot" = $1::jsonb
      WHERE "id" = $2
    `,
    [
      JSON.stringify({
        schemaVersion: 1,
        framework: "codex",
        runnerProfile: "x".repeat(255),
      }),
      runId,
    ],
  );

  const invalidObjects: readonly unknown[] = [
    { framework: "codex", runnerProfile: "vm0/default" },
    { schemaVersion: 1, runnerProfile: "vm0/default" },
    { schemaVersion: 1, framework: "codex" },
    {
      schemaVersion: 1,
      framework: "codex",
      runnerProfile: "vm0/default",
      extra: "rejected",
    },
    { schemaVersion: 2, framework: "codex", runnerProfile: "vm0/default" },
    {
      schemaVersion: 2,
      framework: "codex",
      runnerProfile: "vm0/default",
      piMemoryGenerationEnabled: "true",
    },
    {
      schemaVersion: 2,
      framework: "codex",
      runnerProfile: "vm0/default",
      piMemoryGenerationEnabled: true,
      extra: "rejected",
    },
    {
      schemaVersion: 3,
      framework: "codex",
      runnerProfile: "vm0/default",
      piMemoryGenerationEnabled: true,
    },
    {
      schemaVersion: 3,
      framework: "codex",
      runnerProfile: "vm0/default",
      extra: "rejected",
    },
    { schemaVersion: 3, framework: "codex" },
    { schemaVersion: 3, runnerProfile: "vm0/default" },
    { schemaVersion: 3, framework: "gemini", runnerProfile: "vm0/default" },
    { schemaVersion: 3, framework: "codex", runnerProfile: "" },
    { schemaVersion: 3, framework: "codex", runnerProfile: "x".repeat(256) },
    { schemaVersion: 4, framework: "codex", runnerProfile: "vm0/default" },
    { schemaVersion: "3", framework: "codex", runnerProfile: "vm0/default" },
    ...(!supportsV2
      ? [
          {
            schemaVersion: 2,
            framework: "codex",
            runnerProfile: "vm0/default",
            piMemoryGenerationEnabled: true,
          },
        ]
      : []),
    {
      schemaVersion: "1",
      framework: "codex",
      runnerProfile: "vm0/default",
    },
    { schemaVersion: 1, framework: 1, runnerProfile: "vm0/default" },
    { schemaVersion: 1, framework: "codex", runnerProfile: 1 },
    { schemaVersion: 1, framework: "gemini", runnerProfile: "vm0/default" },
    { schemaVersion: 1, framework: "codex", runnerProfile: "" },
    {
      schemaVersion: 1,
      framework: "codex",
      runnerProfile: "x".repeat(256),
    },
    [],
    1,
    null,
  ];
  for (const value of invalidObjects) {
    await expectConstraintViolation(client, runId, value);
  }

  await client.query(
    `UPDATE "agent_runs" SET "launch_snapshot" = NULL WHERE "id" = $1`,
    [runId],
  );
}

function validateCallerIsolation(): void {
  const runtimeFiles = trackedFilesWithPattern(
    "AgentRunLaunchSnapshot|launchSnapshot|launch_snapshot",
    [
      "turbo/apps",
      "turbo/packages/api-contracts",
      "turbo/packages/core",
      "crates",
      "e2e",
    ],
  );
  assert.deepEqual(runtimeFiles, [
    "turbo/apps/api/src/signals/routes/__tests__/chat-events.bdd.test.ts",
    "turbo/apps/api/src/signals/routes/__tests__/computer-use.bdd.test.ts",
    "turbo/apps/api/src/signals/routes/__tests__/helpers/runtime-state.ts",
    "turbo/apps/api/src/signals/routes/__tests__/run-lifecycle.bdd.test.ts",
    "turbo/apps/api/src/signals/routes/test-runtime-state.ts",
    "turbo/apps/api/src/signals/services/agent-run-create.service.ts",
    "turbo/apps/api/src/signals/services/agent-webhook-checkpoints.service.ts",
    "turbo/apps/api/src/signals/services/agent-webhook-complete.service.ts",
    "turbo/apps/api/src/signals/services/log-detail-run-selection.ts",
    "turbo/apps/api/src/signals/services/logs.service.ts",
    "turbo/apps/api/src/test-fixtures/agent-runs.ts",
    "turbo/apps/api/src/test-fixtures/pi-memory-stage1-candidates.ts",
    "turbo/packages/api-contracts/src/contracts/test-runtime-state.ts",
  ]);

  const databaseSourceFiles = trackedFilesWithPattern(
    "AgentRunLaunchSnapshot|launchSnapshot|launch_snapshot",
    [
      ":(glob)turbo/packages/db/src/**/*.ts",
      ":(exclude,glob)turbo/packages/db/src/__tests__/**",
      ":(exclude,glob)turbo/packages/db/src/migrations/**",
    ],
  );
  assert.deepEqual(databaseSourceFiles, [
    "turbo/packages/db/src/jsonb-contracts/agent-run-session-conversation.ts",
    "turbo/packages/db/src/schema/agent-run-session-conversation.ts",
  ]);

  const contractFiles = trackedFilesWithPattern(
    "export type AgentRunLaunchSnapshot",
    [":(glob)turbo/packages/db/src/jsonb-contracts/**/*.ts"],
  );
  assert.deepEqual(contractFiles, [
    "turbo/packages/db/src/jsonb-contracts/agent-run-session-conversation.ts",
  ]);
}

function validateMigrationSql(migrationSql: string): void {
  const executableSql = migrationSql.replace(/^--.*$/gmu, "");
  assert.ok(migrationSql.startsWith("-- vm0:non-transactional\n"));
  assert.match(executableSql, /ADD COLUMN "launch_snapshot" jsonb;/u);
  assert.doesNotMatch(
    executableSql,
    /ADD COLUMN "launch_snapshot" jsonb[^;]*\bDEFAULT\b/iu,
  );
  assert.match(executableSql, /NOT VALID/iu);
  assert.match(
    executableSql,
    /VALIDATE CONSTRAINT "agent_runs_launch_snapshot_check"/u,
  );
  assert.equal(
    [...executableSql.matchAll(/SET LOCAL lock_timeout = '1s'/gu)].length,
    2,
  );
  assert.doesNotMatch(executableSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(executableSql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/iu);
  assert.doesNotMatch(executableSql, /\bCREATE\s+TRIGGER\b/iu);
  assert.doesNotMatch(executableSql, /\bUPDATE\s+"agent_runs"\b/iu);
  assert.doesNotMatch(executableSql, /\bINSERT\s+INTO\s+"agent_runs"\b/iu);
  assert.doesNotMatch(executableSql, /\bDELETE\s+FROM\s+"agent_runs"\b/iu);
}

function validateV3MigrationSql(migrationSql: string): readonly string[] {
  const statements = migrationStatements(migrationSql);
  const executableSql = migrationSql.replace(/^--.*$/gmu, "");
  assert.ok(migrationSql.startsWith("-- vm0:non-transactional\n"));
  assert.equal(statements.length, 8);
  assert.match(
    migrationStatementAt(statements, 0),
    new RegExp(`DROP CONSTRAINT IF EXISTS "${v3ConstraintName}"`, "u"),
  );
  assert.match(
    migrationStatementAt(statements, 1),
    new RegExp(`ADD CONSTRAINT "${v3ConstraintName}"`, "u"),
  );
  assert.match(migrationStatementAt(statements, 1), /NOT VALID;$/u);
  assert.equal(migrationStatementAt(statements, 2), "COMMIT;");
  assert.match(
    migrationStatementAt(statements, 3),
    new RegExp(`VALIDATE CONSTRAINT "${v3ConstraintName}"`, "u"),
  );
  assert.equal(migrationStatementAt(statements, 4), "COMMIT;");
  assert.match(
    migrationStatementAt(statements, 5),
    new RegExp(`DROP CONSTRAINT "${constraintName}"`, "u"),
  );
  assert.equal(
    migrationStatementAt(statements, 6),
    `ALTER TABLE "agent_runs" RENAME CONSTRAINT "${v3ConstraintName}" TO "${constraintName}";`,
  );
  assert.equal(migrationStatementAt(statements, 7), "COMMIT;");
  assert.equal(
    [...executableSql.matchAll(/SET LOCAL lock_timeout = '1s'/gu)].length,
    3,
  );
  assert.doesNotMatch(executableSql, /\bUPDATE\s+"agent_runs"\b/iu);
  assert.doesNotMatch(executableSql, /\bINSERT\s+INTO\s+"agent_runs"\b/iu);
  assert.doesNotMatch(executableSql, /\bDELETE\s+FROM\s+"agent_runs"\b/iu);
  return statements;
}

export async function validateAgentRunLaunchSnapshotMigration(): Promise<void> {
  console.log("=== Validate Agent Run launch-snapshot migration ===\n");
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const upgradeUrl = new URL(databaseUrl);
  upgradeUrl.pathname = `/${upgradeDatabase}`;
  const migrationPath = path.join(
    migrationsDirectory,
    `${launchSnapshotMigration}.sql`,
  );
  const migrationSql = await fs.readFile(migrationPath, "utf8");
  const statements = migrationStatements(migrationSql);
  const validateIndex = statements.findIndex((statement) => {
    return statement.includes(`VALIDATE CONSTRAINT "${constraintName}"`);
  });
  assert.notEqual(validateIndex, -1);
  let validationBeginIndex = -1;
  for (let index = validateIndex - 1; index >= 0; index -= 1) {
    if (statements[index]?.endsWith("BEGIN;")) {
      validationBeginIndex = index;
      break;
    }
  }
  assert.notEqual(validationBeginIndex, -1);
  const catalogPhase = statements.slice(0, validationBeginIndex);
  const uncommittedValidationPhase = statements.slice(
    validationBeginIndex,
    validateIndex + 1,
  );

  validateMigrationSql(migrationSql);
  validateCallerIsolation();

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(
    `DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`,
  );
  await admin.query(`CREATE DATABASE "${upgradeDatabase}"`);

  const setup = new Client({ connectionString: upgradeUrl.toString() });
  const blocker = new Client({ connectionString: upgradeUrl.toString() });
  const migrator = new Client({ connectionString: upgradeUrl.toString() });
  const dml = new Client({ connectionString: upgradeUrl.toString() });
  await setup.connect();
  await blocker.connect();
  await migrator.connect();
  await dml.connect();

  try {
    await applyMigrationsFromDirectoryUpToTag(
      setup,
      migrationsDirectory,
      previousMigration,
    );
    const fixture = {
      agentId: "00000000-0000-4000-8000-000000093301",
      runId: "00000000-0000-4000-8000-000000093303",
      sessionId: "00000000-0000-4000-8000-000000093302",
      suffix: "upgrade",
    } as const;
    await seedAgentRun(setup, fixture);
    const relationFileNode = await readAgentRunsRelationFileNode(setup);

    await blocker.query("BEGIN");
    await blocker.query(`LOCK TABLE "agent_runs" IN ACCESS SHARE MODE`);
    const lockStartedAt = Date.now();
    await assert.rejects(
      applyMigrationsFromDirectoryUpToTag(
        migrator,
        migrationsDirectory,
        launchSnapshotMigration,
      ),
      (error: unknown) => {
        return databaseErrorCode(error) === "55P03";
      },
    );
    const lockWaitMilliseconds = Date.now() - lockStartedAt;
    assert.ok(lockWaitMilliseconds >= 750);
    assert.ok(lockWaitMilliseconds < 2_500);
    await migrator.query("ROLLBACK");
    await blocker.query("COMMIT");

    await executeStatements(migrator, catalogPhase);
    assert.equal(await readAgentRunsRelationFileNode(setup), relationFileNode);
    assert.deepEqual(await readLaunchSnapshotCatalog(setup), {
      type: "jsonb",
      isNullable: "YES",
      columnDefault: null,
      hasMissing: false,
    });
    const unvalidatedConstraint = await readConstraintCatalog(setup);
    assert.equal(unvalidatedConstraint.validated, false);
    assert.match(unvalidatedConstraint.definition, /schemaVersion/u);
    assert.match(unvalidatedConstraint.definition, /runnerProfile/u);
    const historical = await setup.query<{ launchSnapshot: unknown }>(
      `
        SELECT "launch_snapshot" AS "launchSnapshot"
        FROM "agent_runs"
        WHERE "id" = $1
      `,
      [fixture.runId],
    );
    assert.deepEqual(historical.rows, [{ launchSnapshot: null }]);
    await expectConstraintViolation(setup, fixture.runId, {
      schemaVersion: 1,
      framework: "codex",
      runnerProfile: "",
    });

    await executeStatements(migrator, uncommittedValidationPhase);
    const validationLocks = await setup.query<{ mode: string }>(
      `
        SELECT "mode"
        FROM "pg_locks"
        WHERE "pid" = $1
          AND "relation" = 'public.agent_runs'::regclass
          AND "granted"
      `,
      [
        (
          await migrator.query<{ pid: number }>(
            `SELECT pg_backend_pid() AS "pid"`,
          )
        ).rows[0]!.pid,
      ],
    );
    assert.ok(
      validationLocks.rows.some(({ mode }) => {
        return mode === "ShareUpdateExclusiveLock";
      }),
    );

    await dml.query(`SET statement_timeout = '2s'`);
    const dmlStartedAt = Date.now();
    const dmlRunId = "00000000-0000-4000-8000-000000093304";
    await dml.query(
      `
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "session_id", "status", "prompt"
        ) VALUES ($1, $2, $3, $4, 'pending', 'validation dml')
      `,
      [
        dmlRunId,
        "launch-snapshot-upgrade-user",
        "launch-snapshot-upgrade-org",
        fixture.sessionId,
      ],
    );
    await dml.query(
      `UPDATE "agent_runs" SET "prompt" = 'validation dml updated' WHERE "id" = $1`,
      [dmlRunId],
    );
    await dml.query(`DELETE FROM "agent_runs" WHERE "id" = $1`, [dmlRunId]);
    assert.ok(Date.now() - dmlStartedAt < 2_000);
    await migrator.query("COMMIT");

    const validatedConstraint = await readConstraintCatalog(setup);
    assert.equal(validatedConstraint.validated, true);
    await validateConstraintValues(setup, fixture.runId, false, false);

    await applyMigrationsFromDirectoryUpToTag(
      setup,
      migrationsDirectory,
      launchSnapshotMigration,
    );
    await executeStatements(setup, statements);
    assert.equal((await readConstraintCatalog(setup)).validated, true);

    await setup.query("BEGIN");
    await setup.query(
      `ALTER TABLE "agent_runs" DROP CONSTRAINT "${constraintName}"`,
    );
    await setup.query(
      `
        ALTER TABLE "agent_runs"
        ADD CONSTRAINT "${constraintName}"
        CHECK ("launch_snapshot" IS NULL) NOT VALID
      `,
    );
    await assert.rejects(
      executeStatements(setup, catalogPhase),
      /agent_runs_launch_snapshot_check has a conflicting definition/u,
    );
    await setup.query("ROLLBACK");
    assert.equal((await readConstraintCatalog(setup)).validated, true);

    console.log("   ✅ NULL and all three strict v1 frameworks are accepted");
    console.log(
      "   ✅ malformed, extra-key, and oversized values are rejected",
    );
    console.log(
      "   ✅ nullable ADD COLUMN preserves rows and relation storage",
    );
    console.log(
      "   ✅ conflicting catalog locks fail near the one-second bound",
    );
    console.log("   ✅ ordinary DML remains healthy under validation lock");
    console.log("   ✅ migration retries are exact and idempotent");
    console.log("   ✅ runtime launch-snapshot caller inventory is exact\n");
  } finally {
    await blocker.query("ROLLBACK");
    await migrator.query("ROLLBACK");
    await setup.query("ROLLBACK");
    await dml.end();
    await migrator.end();
    await blocker.end();
    await setup.end();
    await admin.query(
      `DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`,
    );
    await admin.end();
  }
}

export async function validateAgentRunLaunchSnapshotV3Migration(): Promise<void> {
  console.log("=== Validate Agent Run launch-snapshot V3 upgrade ===\n");
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const upgradeUrl = new URL(databaseUrl);
  upgradeUrl.pathname = `/${v3UpgradeDatabase}`;
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${launchSnapshotV3Migration}.sql`),
    "utf8",
  );
  const statements = validateV3MigrationSql(migrationSql);

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(
    `DROP DATABASE IF EXISTS "${v3UpgradeDatabase}" WITH (FORCE)`,
  );
  await admin.query(`CREATE DATABASE "${v3UpgradeDatabase}"`);

  const setup = new Client({ connectionString: upgradeUrl.toString() });
  const blocker = new Client({ connectionString: upgradeUrl.toString() });
  const migrator = new Client({ connectionString: upgradeUrl.toString() });
  await setup.connect();
  await blocker.connect();
  await migrator.connect();

  try {
    await applyMigrationsFromDirectoryUpToTag(
      setup,
      migrationsDirectory,
      previousV3Migration,
    );
    await seedHistoricalLaunchSnapshotMatrix(setup);
    const historicalBefore = await readHistoricalLaunchSnapshotRows(setup);
    assert.deepEqual(
      historicalBefore.map(({ launchSnapshot, runId }) => {
        return { runId, launchSnapshot };
      }),
      historicalLaunchSnapshotRows,
    );
    const catalogBefore = await readLaunchSnapshotConstraintCatalog(setup);
    assert.equal(catalogBefore.length, 1);
    const preV3Constraint = catalogBefore[0];
    assert.ok(preV3Constraint);
    assert.equal(preV3Constraint.name, constraintName);
    assert.equal(preV3Constraint.validated, true);
    assert.match(preV3Constraint.definition, /'2'::jsonb/u);
    assert.doesNotMatch(preV3Constraint.definition, /'3'::jsonb/u);
    assert.equal(
      await readTrackedMigrationCount(setup, launchSnapshotV3Migration),
      0,
    );

    await blocker.query("BEGIN");
    await blocker.query(`LOCK TABLE "agent_runs" IN ACCESS SHARE MODE`);
    const lockStartedAt = Date.now();
    await assert.rejects(
      applyMigrationsFromDirectoryUpToTag(
        migrator,
        migrationsDirectory,
        launchSnapshotV3Migration,
      ),
      (error: unknown) => {
        return databaseErrorCode(error) === "55P03";
      },
    );
    const lockWaitMilliseconds = Date.now() - lockStartedAt;
    assert.ok(lockWaitMilliseconds >= 750);
    assert.ok(lockWaitMilliseconds < 2_500);
    await migrator.query("ROLLBACK");
    await blocker.query("COMMIT");

    assert.equal(
      await readTrackedMigrationCount(setup, launchSnapshotV3Migration),
      0,
    );
    assert.deepEqual(
      await readLaunchSnapshotConstraintCatalog(setup),
      catalogBefore,
    );
    assert.deepEqual(
      await readHistoricalLaunchSnapshotRows(setup),
      historicalBefore,
    );

    await applyMigrationsFromDirectoryUpToTag(
      migrator,
      migrationsDirectory,
      launchSnapshotV3Migration,
    );
    assert.equal(
      await readTrackedMigrationCount(setup, launchSnapshotV3Migration),
      1,
    );
    assert.deepEqual(
      await readHistoricalLaunchSnapshotRows(setup),
      historicalBefore,
    );
    const catalogAfter = await readLaunchSnapshotConstraintCatalog(setup);
    assert.equal(catalogAfter.length, 1);
    const v3Constraint = catalogAfter[0];
    assert.ok(v3Constraint);
    assert.equal(v3Constraint.name, constraintName);
    assert.equal(v3Constraint.validated, true);
    assert.match(v3Constraint.definition, /'1'::jsonb/u);
    assert.match(v3Constraint.definition, /'2'::jsonb/u);
    assert.match(v3Constraint.definition, /'3'::jsonb/u);

    const validationFixture = {
      agentId: "00000000-0000-4000-8000-000000106821",
      sessionId: "00000000-0000-4000-8000-000000106822",
      runId: "00000000-0000-4000-8000-000000106823",
      suffix: "v3-values",
    } as const;
    await seedCanonicalAgentRun(setup, validationFixture);
    await validateConstraintValues(setup, validationFixture.runId, true, true);

    await executeStatements(setup, statements);
    assert.equal(
      await readTrackedMigrationCount(setup, launchSnapshotV3Migration),
      1,
    );
    assert.deepEqual(
      await readHistoricalLaunchSnapshotRows(setup),
      historicalBefore,
    );
    assert.deepEqual(
      await readLaunchSnapshotConstraintCatalog(setup),
      catalogAfter,
    );

    console.log(
      "   ✅ pre-1068 V1 and V2 true/false rows cover every framework",
    );
    console.log(
      "   ✅ the tracked V3 migration preserves exact JSONB bytes and row versions",
    );
    console.log(
      "   ✅ a bounded lock timeout leaves catalog and historical rows unchanged",
    );
    console.log(
      "   ✅ the canonical validated constraint accepts strict V1/V2/V3 values",
    );
    console.log("   ✅ successful exact migration reruns are idempotent\n");
  } finally {
    await blocker.query("ROLLBACK");
    await migrator.query("ROLLBACK");
    await setup.query("ROLLBACK");
    await migrator.end();
    await blocker.end();
    await setup.end();
    await admin.query(
      `DROP DATABASE IF EXISTS "${v3UpgradeDatabase}" WITH (FORCE)`,
    );
    await admin.end();
  }
}

export async function validateAgentRunLaunchSnapshotSchema(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate fresh Agent Run launch-snapshot schema ===\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const fixture = {
    agentId: "00000000-0000-4000-8000-000000093311",
    runId: "00000000-0000-4000-8000-000000093313",
    sessionId: "00000000-0000-4000-8000-000000093312",
    suffix: "fresh",
  } as const;
  try {
    assert.deepEqual(await readLaunchSnapshotCatalog(client), {
      type: "jsonb",
      isNullable: "YES",
      columnDefault: null,
      hasMissing: false,
    });
    assert.equal((await readConstraintCatalog(client)).validated, true);
    await seedCanonicalAgentRun(client, fixture);
    await validateConstraintValues(client, fixture.runId, true, true);
    console.log(
      "   ✅ fresh schema matches the nullable strict v1/v2/v3 contract\n",
    );
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  await validateAgentRunLaunchSnapshotMigration();
  await validateAgentRunLaunchSnapshotV3Migration();
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
