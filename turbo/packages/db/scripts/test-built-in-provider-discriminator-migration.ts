import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(dirname, "../src/migrations");
const EXPANDED_MIGRATION = "1013_calm_darwin";
const BRIDGE_MIGRATION = "1014_built_in_provider_bridge_backfill";
const CANONICAL_SCHEMA_MIGRATION = "1015_canonical_built_in_provider_schema";

interface ProviderRowSnapshot {
  readonly id: string;
  readonly rest: Record<string, unknown>;
  readonly type: string | null;
}

function databaseErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return "";
  }
  const message = Reflect.get(error, "message");
  return typeof message === "string" ? message : "";
}

function createDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function executeOnAdminDatabase(
  baseUrl: string,
  sql: string,
): Promise<void> {
  const client = new Client({
    connectionString: createDatabaseUrl(baseUrl, "postgres"),
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function createDatabase(
  baseUrl: string,
  databaseName: string,
): Promise<string> {
  await executeOnAdminDatabase(
    baseUrl,
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
  );
  await executeOnAdminDatabase(baseUrl, `CREATE DATABASE "${databaseName}"`);
  return createDatabaseUrl(baseUrl, databaseName);
}

async function dropDatabase(
  baseUrl: string,
  databaseName: string,
): Promise<void> {
  await executeOnAdminDatabase(
    baseUrl,
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
  );
}

async function applyThrough(client: Client, tag: string): Promise<void> {
  await applyMigrationsFromDirectoryUpToTag(client, MIGRATIONS_DIR, tag);
}

async function snapshotRows(
  client: Client,
  tableName: string,
  columnName: string,
): Promise<readonly ProviderRowSnapshot[]> {
  const result = await client.query<ProviderRowSnapshot>(`
    SELECT
      "row"."id"::text AS "id",
      "row"."${columnName}" AS "type",
      to_jsonb("row") - '${columnName}' AS "rest"
    FROM "${tableName}" AS "row"
    ORDER BY "row"."id"
  `);
  return result.rows;
}

function expectedCanonicalRows(
  before: readonly ProviderRowSnapshot[],
): readonly ProviderRowSnapshot[] {
  return before.map((row) => {
    return {
      ...row,
      type: row.type === "vm0" ? "built-in" : row.type,
    };
  });
}

async function assertNoLegacyValues(client: Client): Promise<void> {
  const result = await client.query<{ count: number }>(`
    SELECT (
      (SELECT count(*) FROM "agent_runs" WHERE "model_provider" = 'vm0') +
      (SELECT count(*) FROM "chat_threads" WHERE "model_provider_type" = 'vm0') +
      (SELECT count(*) FROM "org_model_policies" WHERE "default_provider_type" = 'vm0') +
      (SELECT count(*) FROM "model_providers" WHERE "type" = 'vm0')
    )::integer AS "count"
  `);
  assert.deepEqual(result.rows, [{ count: 0 }]);
}

async function validateBridgeAndBackfill(baseUrl: string): Promise<void> {
  const databaseName = "migration_test_builtin_provider_29910";
  const databaseUrl = await createDatabase(baseUrl, databaseName);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const ids = {
    session: "00000000-0000-4000-8000-000000299120",
    vm0Run: "00000000-0000-4000-8000-000000299121",
    canonicalRun: "00000000-0000-4000-8000-000000299122",
    historicalRun: "00000000-0000-4000-8000-000000299123",
    nullRun: "00000000-0000-4000-8000-000000299124",
    vm0Thread: "00000000-0000-4000-8000-000000299125",
    canonicalThread: "00000000-0000-4000-8000-000000299126",
    historicalThread: "00000000-0000-4000-8000-000000299127",
    nullThread: "00000000-0000-4000-8000-000000299128",
    vm0Policy: "00000000-0000-4000-8000-000000299129",
    canonicalPolicy: "00000000-0000-4000-8000-000000299130",
    historicalPolicy: "00000000-0000-4000-8000-000000299131",
    vm0Provider: "00000000-0000-4000-8000-000000299132",
    canonicalProvider: "00000000-0000-4000-8000-000000299133",
    historicalProvider: "00000000-0000-4000-8000-000000299134",
  } as const;

  try {
    await applyThrough(client, EXPANDED_MIGRATION);
    await client.query(
      `INSERT INTO "agent_sessions" ("id", "user_id", "org_id") VALUES ($1, 'provider-migration-user', 'provider-migration-org')`,
      [ids.session],
    );
    await client.query(
      `
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "session_id", "status", "prompt",
          "trigger_source", "autonomy_budget", "model_provider", "selected_model"
        ) VALUES
          ($1, 'provider-migration-user', 'provider-migration-org', $5, 'completed', 'legacy', 'chat', 1, 'vm0', 'gpt-5.6-sol'),
          ($2, 'provider-migration-user', 'provider-migration-org', $5, 'completed', 'canonical new-app/old-DB', 'chat', 2, 'built-in', 'gpt-5.6-luna'),
          ($3, 'provider-migration-user', 'provider-migration-org', $5, 'completed', 'historical', 'chat', 3, 'VM0', 'gpt-5.5'),
          ($4, 'provider-migration-user', 'provider-migration-org', $5, 'completed', 'null', NULL, NULL, NULL, NULL)
      `,
      [
        ids.vm0Run,
        ids.canonicalRun,
        ids.historicalRun,
        ids.nullRun,
        ids.session,
      ],
    );
    await client.query(
      `
        INSERT INTO "chat_threads" (
          "id", "user_id", "title", "model_provider_type", "selected_model"
        ) VALUES
          ($1, 'provider-migration-user', 'legacy', 'vm0', 'gpt-5.6-sol'),
          ($2, 'provider-migration-user', 'canonical new-app/old-DB', 'built-in', 'gpt-5.6-luna'),
          ($3, 'provider-migration-user', 'historical', 'VM0', 'gpt-5.5'),
          ($4, 'provider-migration-user', 'null', NULL, NULL)
      `,
      [
        ids.vm0Thread,
        ids.canonicalThread,
        ids.historicalThread,
        ids.nullThread,
      ],
    );
    await client.query(`
      INSERT INTO "chat_threads" (
        "id", "user_id", "title", "model_provider_type"
      )
      SELECT
        md5('provider-discriminator-batch-' || "value"::text)::uuid,
        'provider-batch-user-' || "value"::text,
        'bounded backfill ' || "value"::text,
        'vm0'
      FROM generate_series(1, 5001) AS "value"
    `);
    await client.query(
      `
        INSERT INTO "org_model_policies" (
          "id", "org_id", "model", "default_provider_type",
          "credential_scope", "created_by_user_id"
        ) VALUES
          ($1, 'provider-migration-org', 'gpt-5.6-sol', 'vm0', 'org', 'legacy-writer'),
          ($2, 'provider-migration-org', 'gpt-5.6-luna', 'built-in', 'org', 'new-writer'),
          ($3, 'provider-migration-org', 'gpt-5.5', 'VM0', 'org', 'historical-writer')
      `,
      [ids.vm0Policy, ids.canonicalPolicy, ids.historicalPolicy],
    );
    await client.query(
      `
        INSERT INTO "model_providers" (
          "id", "org_id", "user_id", "type", "selected_model", "plan_type"
        ) VALUES
          ($1, 'provider-migration-org-legacy', '__org__', 'vm0', 'gpt-5.6-sol', 'legacy-plan'),
          ($2, 'provider-migration-org-canonical', '__org__', 'built-in', 'gpt-5.6-luna', 'canonical-plan'),
          ($3, 'provider-migration-org-historical', '__org__', 'VM0', 'gpt-5.5', 'historical-plan')
      `,
      [ids.vm0Provider, ids.canonicalProvider, ids.historicalProvider],
    );

    const surfaces = [
      ["agent_runs", "model_provider"],
      ["chat_threads", "model_provider_type"],
      ["org_model_policies", "default_provider_type"],
      ["model_providers", "type"],
    ] as const;
    const before = new Map<string, readonly ProviderRowSnapshot[]>();
    for (const [tableName, columnName] of surfaces) {
      before.set(tableName, await snapshotRows(client, tableName, columnName));
    }

    const oldSchemaCanonicalRows = await client.query<{ count: number }>(`
      SELECT (
        (SELECT count(*) FROM "agent_runs" WHERE "model_provider" = 'built-in') +
        (SELECT count(*) FROM "chat_threads" WHERE "model_provider_type" = 'built-in') +
        (SELECT count(*) FROM "org_model_policies" WHERE "default_provider_type" = 'built-in') +
        (SELECT count(*) FROM "model_providers" WHERE "type" = 'built-in')
      )::integer AS "count"
    `);
    assert.deepEqual(oldSchemaCanonicalRows.rows, [{ count: 4 }]);

    await applyThrough(client, CANONICAL_SCHEMA_MIGRATION);
    await assertNoLegacyValues(client);

    for (const [tableName, columnName] of surfaces) {
      const beforeRows = before.get(tableName);
      assert.ok(beforeRows);
      const afterRows = await snapshotRows(client, tableName, columnName);
      assert.deepEqual(afterRows, expectedCanonicalRows(beforeRows));
    }

    const firstCanonicalState = new Map<
      string,
      readonly ProviderRowSnapshot[]
    >();
    for (const [tableName, columnName] of surfaces) {
      firstCanonicalState.set(
        tableName,
        await snapshotRows(client, tableName, columnName),
      );
    }

    await client.query(
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = $1`,
      [BRIDGE_MIGRATION],
    );
    await applyThrough(client, BRIDGE_MIGRATION);
    await assertNoLegacyValues(client);
    for (const [tableName, columnName] of surfaces) {
      assert.deepEqual(
        await snapshotRows(client, tableName, columnName),
        firstCanonicalState.get(tableName),
      );
    }

    console.log(
      "   ✅ new-app/before-bridge built-in SQL is accepted by the expanded schema",
    );
    console.log(
      "   ✅ 5,001-row input crosses the 5,000-row bounded backfill boundary",
    );
    console.log(
      "   ✅ exact vm0 rows alone are canonicalized with row ids and every other field preserved",
    );
    console.log(
      "   ✅ bridge migration replay is restartable and produces an identical state",
    );
  } finally {
    await client.end();
    await dropDatabase(baseUrl, databaseName);
  }
}

async function validateCollisionAndDriftFailures(
  baseUrl: string,
): Promise<void> {
  const databaseName = "migration_test_builtin_provider_collision_29910";
  const databaseUrl = await createDatabase(baseUrl, databaseName);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const legacyId = "00000000-0000-4000-8000-000000299141";
  const canonicalId = "00000000-0000-4000-8000-000000299142";

  try {
    await applyThrough(client, EXPANDED_MIGRATION);
    await client.query(
      `
        INSERT INTO "model_providers" ("id", "org_id", "user_id", "type", "selected_model")
        VALUES
          ($1, 'provider-collision-org', '__org__', 'vm0', 'gpt-5.6-sol'),
          ($2, 'provider-collision-org', '__org__', 'built-in', 'gpt-5.6-luna')
      `,
      [legacyId, canonicalId],
    );
    const before = await client.query<{
      id: string;
      selectedModel: string;
      type: string;
    }>(`
      SELECT
        "id"::text AS "id", "selected_model" AS "selectedModel", "type"
      FROM "model_providers"
      WHERE "org_id" = 'provider-collision-org'
      ORDER BY "id"
    `);

    await assert.rejects(
      applyThrough(client, BRIDGE_MIGRATION),
      (error: unknown) => {
        return databaseErrorMessage(error).includes(
          "vm0/built-in identity collision",
        );
      },
    );
    const afterCollisionFailure = await client.query<{
      id: string;
      selectedModel: string;
      type: string;
    }>(`
      SELECT
        "id"::text AS "id", "selected_model" AS "selectedModel", "type"
      FROM "model_providers"
      WHERE "org_id" = 'provider-collision-org'
      ORDER BY "id"
    `);
    assert.deepEqual(afterCollisionFailure.rows, before.rows);

    await client.query(`DELETE FROM "model_providers" WHERE "id" = $1`, [
      canonicalId,
    ]);
    await client.query(`DROP INDEX "idx_model_providers_org_user_type"`);
    await client.query(`
      CREATE UNIQUE INDEX "idx_model_providers_org_user_type"
      ON "model_providers" ("org_id", "type", "user_id")
    `);
    await assert.rejects(
      applyThrough(client, BRIDGE_MIGRATION),
      (error: unknown) => {
        return databaseErrorMessage(error).includes(
          "provider-identity unique index drifted",
        );
      },
    );

    console.log(
      "   ✅ alias-pair collisions abort without merging, deleting, or changing either row",
    );
    console.log(
      "   ✅ provider-identity unique-index drift aborts before any backfill\n",
    );
  } finally {
    await client.end();
    await dropDatabase(baseUrl, databaseName);
  }
}

export async function validateBuiltInProviderDiscriminatorMigration(
  baseUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 1.31: Validate built-in provider writer/backfill boundary ===\n",
  );
  await validateBridgeAndBackfill(baseUrl);
  await validateCollisionAndDriftFailures(baseUrl);
}
