import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import postgres from "postgres";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import { applyPendingMigrations } from "./migration-runner";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.join(scriptDirectory, "..");
const migrationsDirectory = path.join(packageDirectory, "src/migrations");
const previousMigration = "0948_custom_model_gateway_provider_types";
const nullableMigration = "0949_confused_machine_man";
const upgradeDatabase = "migration_checkpoint_snapshot_nullable";

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function validateMigrationSql(migrationSql: string): void {
  assert.doesNotMatch(migrationSql, /^-- vm0:non-transactional$/mu);
  assert.doesNotMatch(
    migrationSql,
    /\bSET\s+(?:LOCAL\s+)?(?:lock_timeout|statement_timeout)\b/iu,
  );
  assert.equal(
    migrationSql.match(
      /ALTER TABLE "checkpoints" ALTER COLUMN "agent_compose_snapshot" DROP NOT NULL/gu,
    )?.length,
    1,
  );
  assert.doesNotMatch(migrationSql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(migrationSql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/iu);
  assert.doesNotMatch(
    migrationSql,
    /ALTER\s+COLUMN\s+"agent_compose_snapshot"\s+(?:TYPE|SET\s+DATA\s+TYPE|SET\s+DEFAULT|SET\s+NOT\s+NULL)/iu,
  );
}

async function readCheckpointRelationFileNode(client: Client): Promise<string> {
  const result = await client.query<{ fileNode: string }>(`
    SELECT "relfilenode"::text AS "fileNode"
    FROM "pg_class"
    WHERE "oid" = 'public.checkpoints'::regclass
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.fileNode;
}

async function readSnapshotColumn(client: Client): Promise<{
  readonly columnDefault: string | null;
  readonly isNullable: "NO" | "YES";
  readonly type: string;
}> {
  const result = await client.query<{
    columnDefault: string | null;
    isNullable: "NO" | "YES";
    type: string;
  }>(`
    SELECT
      "column_default" AS "columnDefault",
      "is_nullable" AS "isNullable",
      "data_type" AS "type"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'checkpoints'
      AND "column_name" = 'agent_compose_snapshot'
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function seedCheckpointDependencies(
  client: Client,
  suffix: string,
): Promise<{
  readonly conversationId: string;
  readonly runId: string;
}> {
  const numericSuffix = suffix.padStart(3, "0");
  const agentId = `00000000-0000-4000-8000-000000948${numericSuffix}`;
  const sessionId = `10000000-0000-4000-8000-000000948${numericSuffix}`;
  const runId = `20000000-0000-4000-8000-000000948${numericSuffix}`;
  const conversationId = `30000000-0000-4000-8000-000000948${numericSuffix}`;
  const versionId = suffix.repeat(64).slice(0, 64);
  const userId = `checkpoint-nullable-${suffix}-user`;
  const orgId = `checkpoint-nullable-${suffix}-org`;
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, $2, $3, $4)
    `,
    [agentId, userId, `checkpoint nullable ${suffix}`, orgId],
  );
  await client.query(
    `
      INSERT INTO "agent_compose_versions" (
        "id", "compose_id", "content", "created_by"
      ) VALUES ($1, $2, $3::jsonb, $4)
    `,
    [
      versionId,
      agentId,
      JSON.stringify({
        version: "1",
        agents: {
          [`checkpoint-nullable-${suffix}`]: { framework: "claude-code" },
        },
      }),
      userId,
    ],
  );
  await client.query(
    `UPDATE "agent_composes" SET "head_version_id" = $1 WHERE "id" = $2`,
    [versionId, agentId],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      ) VALUES ($1, $2, $3, $4)
    `,
    [sessionId, userId, orgId, agentId],
  );
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id",
        "user_id",
        "org_id",
        "session_id",
        "status",
        "prompt",
        "agent_compose_version_id",
        "launch_snapshot"
      ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb)
    `,
    [
      runId,
      userId,
      orgId,
      sessionId,
      `checkpoint nullable ${suffix}`,
      versionId,
      JSON.stringify({
        schemaVersion: 1,
        framework: "claude-code",
        runnerProfile: "vm0/default",
      }),
    ],
  );
  await client.query(
    `
      INSERT INTO "conversations" (
        "id", "run_id", "cli_agent_type", "cli_agent_session_id"
      ) VALUES ($1, $2, 'claude-code', $3)
    `,
    [conversationId, runId, `checkpoint-nullable-${suffix}`],
  );
  await client.query(
    `UPDATE "agent_sessions" SET "conversation_id" = $1 WHERE "id" = $2`,
    [conversationId, sessionId],
  );
  return { conversationId, runId };
}

async function readSnapshotBytes(
  client: Client,
  runId: string,
): Promise<{
  readonly binary: string | null;
  readonly size: number;
  readonly text: string | null;
}> {
  const result = await client.query<{
    binary: string | null;
    size: number;
    text: string | null;
  }>(
    `
      SELECT
        encode(jsonb_send("agent_compose_snapshot"), 'hex') AS "binary",
        pg_column_size("agent_compose_snapshot")::integer AS "size",
        "agent_compose_snapshot"::text AS "text"
      FROM "checkpoints"
      WHERE "run_id" = $1
    `,
    [runId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function validateWriterIsolation(): Promise<void> {
  const writerPath = path.resolve(
    packageDirectory,
    "../../apps/api/src/signals/services/agent-webhook-checkpoints.service.ts",
  );
  const source = await fs.readFile(writerPath, "utf8");
  const contextStart = source.indexOf(
    "async function loadCheckpointRunContext(",
  );
  const contextEnd = source.indexOf(
    "async function loadSessionHistoryBlobMetadata(",
  );
  assert.ok(contextStart >= 0 && contextEnd > contextStart);
  const contextSource = source.slice(contextStart, contextEnd);
  for (const retiredInput of [
    "agentComposeVersionId",
    "agentComposeVersions",
    "agentComposeSnapshot",
    "secretNames",
    "vars",
  ]) {
    assert.equal(contextSource.includes(retiredInput), false);
  }
  const checkpointFieldsStart = source.indexOf("const checkpointFields = {");
  const checkpointInsertStart = source.indexOf(
    "const [checkpoint] = await db",
    checkpointFieldsStart,
  );
  assert.ok(
    checkpointFieldsStart >= 0 && checkpointInsertStart > checkpointFieldsStart,
  );
  assert.equal(
    source
      .slice(checkpointFieldsStart, checkpointInsertStart)
      .includes("agentComposeSnapshot"),
    false,
  );
}

export async function validateCheckpointAgentComposeSnapshotNullableStatic(): Promise<string> {
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${nullableMigration}.sql`),
    "utf8",
  );
  validateMigrationSql(migrationSql);
  await validateWriterIsolation();
  return migrationSql;
}

export async function validateCheckpointAgentComposeSnapshotNullableMigration(): Promise<void> {
  console.log(
    "=== Validate checkpoint Agent Compose snapshot nullability ===\n",
  );
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const migrationSql =
    await validateCheckpointAgentComposeSnapshotNullableStatic();

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

  const setup = new Client({ connectionString: upgradeUrl.toString() });
  const blocker = new Client({ connectionString: upgradeUrl.toString() });
  const migrator = postgres(upgradeUrl.toString(), { max: 1 });
  await setup.connect();
  await blocker.connect();
  try {
    await applyMigrationsFromDirectoryUpToTag(
      setup,
      migrationsDirectory,
      previousMigration,
    );
    const historical = await seedCheckpointDependencies(setup, "a");
    const historicalSnapshot = {
      agentComposeVersionId: "a".repeat(64),
      vars: { LEGACY_VALUE: "preserve exactly" },
      secretNames: ["LEGACY_SECRET"],
    };
    await setup.query(
      `
        INSERT INTO "checkpoints" (
          "run_id",
          "conversation_id",
          "agent_compose_snapshot",
          "storage_mounts"
        ) VALUES ($1, $2, $3::jsonb, '[]'::jsonb)
      `,
      [
        historical.runId,
        historical.conversationId,
        JSON.stringify(historicalSnapshot),
      ],
    );
    const relationFileNode = await readCheckpointRelationFileNode(setup);
    const historicalBytes = await readSnapshotBytes(setup, historical.runId);
    assert.deepEqual(await readSnapshotColumn(setup), {
      columnDefault: null,
      isNullable: "NO",
      type: "jsonb",
    });

    await blocker.query("BEGIN");
    await blocker.query(`LOCK TABLE "checkpoints" IN ACCESS SHARE MODE`);
    const lockStartedAt = Date.now();
    await assert.rejects(applyPendingMigrations(migrator), (error: unknown) => {
      return databaseErrorCode(error) === "55P03";
    });
    const lockWaitMilliseconds = Date.now() - lockStartedAt;
    assert.ok(lockWaitMilliseconds >= 750);
    assert.ok(lockWaitMilliseconds < 2_500);
    await blocker.query("COMMIT");
    assert.deepEqual(await readSnapshotColumn(setup), {
      columnDefault: null,
      isNullable: "NO",
      type: "jsonb",
    });
    assert.deepEqual(
      await readSnapshotBytes(setup, historical.runId),
      historicalBytes,
    );

    await applyPendingMigrations(migrator);
    assert.equal(await readCheckpointRelationFileNode(setup), relationFileNode);
    assert.deepEqual(await readSnapshotColumn(setup), {
      columnDefault: null,
      isNullable: "YES",
      type: "jsonb",
    });
    assert.deepEqual(
      await readSnapshotBytes(setup, historical.runId),
      historicalBytes,
    );

    const oldWriter = await seedCheckpointDependencies(setup, "b");
    const newWriter = await seedCheckpointDependencies(setup, "c");
    await setup.query(
      `
        INSERT INTO "checkpoints" (
          "run_id", "conversation_id", "agent_compose_snapshot"
        ) VALUES ($1, $2, $3::jsonb)
      `,
      [
        oldWriter.runId,
        oldWriter.conversationId,
        JSON.stringify({ agentComposeVersionId: "b".repeat(64) }),
      ],
    );
    await setup.query(
      `
        INSERT INTO "checkpoints" ("run_id", "conversation_id")
        VALUES ($1, $2)
      `,
      [newWriter.runId, newWriter.conversationId],
    );
    const coexistence = await setup.query<{
      absent: number;
      present: number;
    }>(`
      SELECT
        count(*) FILTER (
          WHERE "agent_compose_snapshot" IS NULL
        )::integer AS "absent",
        count(*) FILTER (
          WHERE "agent_compose_snapshot" IS NOT NULL
        )::integer AS "present"
      FROM "checkpoints"
    `);
    assert.deepEqual(coexistence.rows, [{ absent: 1, present: 2 }]);

    await applyPendingMigrations(migrator);
    await migrator.unsafe(migrationSql);
    assert.equal(await readCheckpointRelationFileNode(setup), relationFileNode);
    assert.deepEqual(
      await readSnapshotBytes(setup, historical.runId),
      historicalBytes,
    );
  } finally {
    await setup.end();
    await blocker.end();
    await migrator.end();
    await admin.query(
      `DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`,
    );
    await admin.end();
  }
  console.log("checkpoint Agent Compose snapshot nullability passed\n");
}

export async function validateCheckpointAgentComposeSnapshotNullableSchema(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    assert.deepEqual(await readSnapshotColumn(client), {
      columnDefault: null,
      isNullable: "YES",
      type: "jsonb",
    });
  } finally {
    await client.end();
  }
}
