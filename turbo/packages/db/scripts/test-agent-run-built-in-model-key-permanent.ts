import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { logDetailRunSelection } from "../../../apps/api/src/signals/services/log-detail-run-selection";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "../../../..");
const metadataPresenceConstraint = "agent_runs_metadata_presence_check";
const retiredBridgeObject = "sync_agent_run_model_key_ids_0971";

interface CanonicalModelKeyRow {
  readonly builtInModelKeyId: string | null;
  readonly id: string;
}

interface PermanentFixture {
  readonly invalidLifecycleRunId: string;
  readonly keyId: string;
  readonly lifecycleRunId: string;
  readonly orgId: string;
  readonly productRunId: string;
  readonly sessionId: string;
  readonly updatedKeyId: string;
  readonly userId: string;
  readonly vendor: string;
}

function createFixture(): PermanentFixture {
  const identity = randomUUID();
  return {
    invalidLifecycleRunId: randomUUID(),
    keyId: randomUUID(),
    lifecycleRunId: randomUUID(),
    orgId: `permanent-agent-run-model-key-org-${identity}`,
    productRunId: randomUUID(),
    sessionId: randomUUID(),
    updatedKeyId: randomUUID(),
    userId: `permanent-agent-run-model-key-user-${identity}`,
    vendor: `permanent-agent-run-model-key-${identity.slice(0, 8)}`,
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

async function validateCanonicalRuntimeCallers(): Promise<void> {
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
      "turbo/apps/api/src/signals/services/agent-run-create.service.ts",
      "turbo/apps/api/src/signals/services/agent-run-metadata-write.service.ts",
      "turbo/apps/api/src/signals/services/agent-webhook-complete.service.ts",
      "turbo/apps/api/src/signals/services/built-in-model-provider-failure.service.ts",
      "turbo/apps/api/src/signals/services/run-cancel.service.ts",
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
  assert.ok(statementStart >= 0);
  const statementSource = selectionSource.slice(statementStart);
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

async function validateCanonicalCatalog(client: Client): Promise<void> {
  const columns = await client.query<{
    columnDefault: string | null;
    columnName: string;
    formattedType: string;
    hasMissing: boolean;
    isGenerated: string;
    isIdentity: string;
    isNullable: string;
  }>(`
    SELECT
      "column_row"."column_name" AS "columnName",
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
      AND "column_row"."column_name" IN (
        'vm0_model_key_id',
        'built_in_model_key_id'
      )
    ORDER BY "column_row"."column_name"
  `);
  assert.deepEqual(columns.rows, [
    {
      columnDefault: null,
      columnName: "built_in_model_key_id",
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
          ON "attribute_row"."attrelid" = 'public.agent_runs'::regclass
          AND "attribute_row"."attname" = 'built_in_model_key_id'
        WHERE "constraint_row"."contype" = 'f'
          AND (
            (
              "constraint_row"."conrelid" = "attribute_row"."attrelid"
              AND "attribute_row"."attnum" = ANY("constraint_row"."conkey")
            ) OR (
              "constraint_row"."confrelid" = "attribute_row"."attrelid"
              AND "attribute_row"."attnum" = ANY("constraint_row"."confkey")
            )
          )
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
    columns: string[];
    definition: string;
    definitionHash: string;
    validated: boolean;
  }>(
    `
      SELECT
        array_agg(
          "attribute_row"."attname"::text
          ORDER BY "attribute_row"."attname"
        ) AS "columns",
        pg_catalog.pg_get_constraintdef("constraint_row"."oid", true)
          AS "definition",
        pg_catalog.md5(
          pg_catalog.pg_get_constraintdef("constraint_row"."oid", true)
        ) AS "definitionHash",
        "constraint_row"."convalidated" AS "validated"
      FROM "pg_catalog"."pg_constraint" AS "constraint_row"
      CROSS JOIN LATERAL unnest("constraint_row"."conkey")
        AS "key_row"("attnum")
      INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
        ON "attribute_row"."attrelid" = "constraint_row"."conrelid"
        AND "attribute_row"."attnum" = "key_row"."attnum"
      WHERE "constraint_row"."conrelid" = 'public.agent_runs'::regclass
        AND "constraint_row"."conname" = $1
        AND "constraint_row"."contype" = 'c'
      GROUP BY "constraint_row"."oid"
    `,
    [metadataPresenceConstraint],
  );
  assert.equal(metadataCheck.rows.length, 1);
  const [metadataRow] = metadataCheck.rows;
  assert.ok(metadataRow);
  assert.equal(metadataRow.validated, true);
  assert.equal(metadataRow.definitionHash, "20ee7ec050f6cd8c9559505d3e7ce2a6");
  assert.deepEqual(metadataRow.columns, [
    "api_started_at",
    "autonomy_budget",
    "built_in_model_key_id",
    "chat_thread_id",
    "codex_service_tier",
    "first_assistant_event_acknowledged_at",
    "goal_id",
    "model_provider",
    "model_provider_credential_scope",
    "model_provider_id",
    "model_runtime_model",
    "model_runtime_provider",
    "selected_image_model",
    "selected_model",
    "selected_video_model",
    "summary",
    "trigger_brief",
    "trigger_source",
    "workflow_automation_id",
  ]);
  assert.ok(metadataRow.definition.includes("built_in_model_key_id IS NULL"));
  assert.equal(metadataRow.definition.includes("vm0_model_key_id"), false);

  const bridgeObjects = await client.query<{
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
    [retiredBridgeObject],
  );
  assert.deepEqual(bridgeObjects.rows, [{ functionCount: 0, triggerCount: 0 }]);

  const legacyReferences = await client.query<{ count: number }>(`
    WITH "catalog_definitions" AS (
      SELECT pg_catalog.pg_get_functiondef("function_row"."oid") AS "definition"
      FROM "pg_catalog"."pg_proc" AS "function_row"
      INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
        ON "namespace_row"."oid" = "function_row"."pronamespace"
      WHERE "function_row"."prokind" IN ('f', 'p')
        AND "namespace_row"."nspname" NOT IN (
          'pg_catalog',
          'information_schema'
        )
        AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'

      UNION ALL

      SELECT pg_catalog.pg_get_ruledef("rule_row"."oid", true)
      FROM "pg_catalog"."pg_rewrite" AS "rule_row"
      INNER JOIN "pg_catalog"."pg_class" AS "relation_row"
        ON "relation_row"."oid" = "rule_row"."ev_class"
      INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
        ON "namespace_row"."oid" = "relation_row"."relnamespace"
      WHERE "namespace_row"."nspname" NOT IN (
          'pg_catalog',
          'information_schema'
        )
        AND "namespace_row"."nspname" !~ '^pg_(toast_)?temp_'

      UNION ALL

      SELECT pg_catalog.pg_get_triggerdef("trigger_row"."oid", true)
      FROM "pg_catalog"."pg_trigger" AS "trigger_row"
      WHERE NOT "trigger_row"."tgisinternal"

      UNION ALL

      SELECT pg_catalog.pg_get_constraintdef("constraint_row"."oid", true)
      FROM "pg_catalog"."pg_constraint" AS "constraint_row"

      UNION ALL

      SELECT pg_catalog.pg_get_indexdef("index_row"."indexrelid")
      FROM "pg_catalog"."pg_index" AS "index_row"
    )
    SELECT count(*)::integer AS "count"
    FROM "catalog_definitions"
    WHERE "definition" ~* '\\mvm0_model_key_id\\M'
  `);
  assert.deepEqual(legacyReferences.rows, [{ count: 0 }]);
}

async function seedFixture(
  client: Client,
  fixture: PermanentFixture,
): Promise<void> {
  await client.query(
    `
      INSERT INTO "built_in_model_keys" ("id", "vendor", "api_key")
      VALUES ($1, $2, 'permanent-agent-run-model-key')
    `,
    [fixture.keyId, fixture.vendor],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" ("id", "user_id", "org_id")
      VALUES ($1, $2, $3)
    `,
    [fixture.sessionId, fixture.userId, fixture.orgId],
  );
}

async function validateCanonicalBehavior(
  client: Client,
  fixture: PermanentFixture,
): Promise<void> {
  const inserted = await client.query<CanonicalModelKeyRow>(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt",
        "trigger_source", "autonomy_budget", "built_in_model_key_id"
      ) VALUES ($1, $2, $3, $4, 'pending', 'permanent canonical model key',
        'chat', 0, $5)
      RETURNING
        "id"::text AS "id",
        "built_in_model_key_id"::text AS "builtInModelKeyId"
    `,
    [
      fixture.productRunId,
      fixture.userId,
      fixture.orgId,
      fixture.sessionId,
      fixture.keyId,
    ],
  );
  assert.deepEqual(inserted.rows, [
    { builtInModelKeyId: fixture.keyId, id: fixture.productRunId },
  ]);

  const [joined] = await drizzle(client)
    .select({
      builtInModelKeyId: agentRuns.builtInModelKeyId,
      id: agentRuns.id,
      vendor: builtInModelKeys.vendor,
    })
    .from(agentRuns)
    .leftJoin(
      builtInModelKeys,
      eq(agentRuns.builtInModelKeyId, builtInModelKeys.id),
    )
    .where(eq(agentRuns.id, fixture.productRunId))
    .limit(1);
  assert.deepEqual(joined, {
    builtInModelKeyId: fixture.keyId,
    id: fixture.productRunId,
    vendor: fixture.vendor,
  });

  const updated = await client.query<CanonicalModelKeyRow>(
    `
      UPDATE "agent_runs"
      SET "built_in_model_key_id" = $1
      WHERE "id" = $2
      RETURNING
        "id"::text AS "id",
        "built_in_model_key_id"::text AS "builtInModelKeyId"
    `,
    [fixture.updatedKeyId, fixture.productRunId],
  );
  assert.deepEqual(updated.rows, [
    {
      builtInModelKeyId: fixture.updatedKeyId,
      id: fixture.productRunId,
    },
  ]);

  const lifecycle = await client.query<CanonicalModelKeyRow>(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt"
      ) VALUES ($1, $2, $3, $4, 'failed', 'permanent lifecycle-only run')
      RETURNING
        "id"::text AS "id",
        "built_in_model_key_id"::text AS "builtInModelKeyId"
    `,
    [fixture.lifecycleRunId, fixture.userId, fixture.orgId, fixture.sessionId],
  );
  assert.deepEqual(lifecycle.rows, [
    { builtInModelKeyId: null, id: fixture.lifecycleRunId },
  ]);

  await assert.rejects(
    client.query(
      `
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "session_id", "status", "prompt",
          "built_in_model_key_id"
        ) VALUES ($1, $2, $3, $4, 'failed',
          'invalid lifecycle model key', $5)
      `,
      [
        fixture.invalidLifecycleRunId,
        fixture.userId,
        fixture.orgId,
        fixture.sessionId,
        fixture.keyId,
      ],
    ),
    (error: unknown) => {
      return (
        databaseErrorCode(error) === "23514" &&
        databaseErrorConstraint(error) === metadataPresenceConstraint
      );
    },
  );

  const [logDetail] = await drizzle(client)
    .select({ run: logDetailRunSelection() })
    .from(agentRuns)
    .where(eq(agentRuns.id, fixture.productRunId))
    .limit(1);
  assert.ok(logDetail);
  assert.deepEqual(Object.keys(logDetail.run).sort(), [
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
  assert.equal(Reflect.has(logDetail.run, "builtInModelKeyId"), false);
  assert.equal(Reflect.has(logDetail.run, "vm0ModelKeyId"), false);

  await assert.rejects(
    client.query(
      `SELECT "vm0_model_key_id" FROM "agent_runs" WHERE "id" = $1`,
      [fixture.productRunId],
    ),
    (error: unknown) => {
      return databaseErrorCode(error) === "42703";
    },
  );
}

export async function validatePermanentAgentRunBuiltInModelKeyState(
  databaseUrl: string,
): Promise<void> {
  console.log(
    "=== Validate permanent Agent Run built-in model key state ===\n",
  );
  await validateCanonicalRuntimeCallers();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const fixture = createFixture();
  try {
    await validateCanonicalCatalog(client);
    await seedFixture(client, fixture);
    await validateCanonicalBehavior(client, fixture);
    console.log("   ✅ active runtime callers are canonical-only");
    console.log("   ✅ canonical nullable UUID and constraint shape are exact");
    console.log("   ✅ legacy column and bridge catalog artifacts are absent");
    console.log(
      "   ✅ canonical reads, writes, joins, nulls, and log detail work\n",
    );
  } finally {
    await client.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [
      fixture.sessionId,
    ]);
    await client.query(`DELETE FROM "built_in_model_keys" WHERE "id" = $1`, [
      fixture.keyId,
    ]);
    await client.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  validatePermanentAgentRunBuiltInModelKeyState(databaseUrl).catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
