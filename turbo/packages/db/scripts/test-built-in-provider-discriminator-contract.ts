import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(dirname, "../src/migrations");
const PRE_CONTRACT_MIGRATION = "1037_morning_brief_phase_b_cleanup";
const CONTRACT_MIGRATION = "1038_contract_legacy_vm0_provider";

const BRIDGE_NAMES = [
  "canonicalize_agent_run_builtin_provider",
  "canonicalize_chat_thread_builtin_provider",
  "canonicalize_model_provider_builtin_type",
  "canonicalize_org_model_policy_builtin_provider",
] as const;

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

async function bridgeObjectCount(client: Client): Promise<number> {
  const result = await client.query<{ count: number }>(
    `
      SELECT (
        (
          SELECT count(*)
          FROM "pg_trigger"
          WHERE "tgname" = ANY($1::text[])
            AND NOT "tgisinternal"
        ) + (
          SELECT count(*)
          FROM "pg_proc" AS "function"
          JOIN "pg_namespace" AS "namespace"
            ON "namespace"."oid" = "function"."pronamespace"
          WHERE "namespace"."nspname" = 'public'
            AND "function"."proname" = ANY($1::text[])
        )
      )::integer AS "count"
    `,
    [BRIDGE_NAMES],
  );
  return result.rows[0]?.count ?? -1;
}

async function seedFinalSweepValues(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE "agent_runs" DISABLE TRIGGER "canonicalize_agent_run_builtin_provider";
    ALTER TABLE "chat_threads" DISABLE TRIGGER "canonicalize_chat_thread_builtin_provider";
    ALTER TABLE "model_providers" DISABLE TRIGGER "canonicalize_model_provider_builtin_type";
    ALTER TABLE "org_model_policies" DISABLE TRIGGER "canonicalize_org_model_policy_builtin_provider";

    INSERT INTO "agent_sessions" ("id", "user_id", "org_id")
    VALUES (
      '00000000-0000-4000-8000-000000306701',
      'provider-contract-user-30671',
      'provider-contract-org-30671'
    );

    INSERT INTO "agent_runs" (
      "id", "user_id", "org_id", "session_id", "status", "prompt",
      "trigger_source", "autonomy_budget", "model_provider"
    ) VALUES
      (
        '00000000-0000-4000-8000-000000306702',
        'provider-contract-user-30671',
        'provider-contract-org-30671',
        '00000000-0000-4000-8000-000000306701',
        'pending',
        'exact legacy provider',
        'chat',
        0,
        'vm0'
      ),
      (
        '00000000-0000-4000-8000-000000306703',
        'provider-contract-user-30671',
        'provider-contract-org-30671',
        '00000000-0000-4000-8000-000000306701',
        'pending',
        'historical provider spelling',
        'chat',
        0,
        'VM0'
      );

    INSERT INTO "chat_threads" (
      "id", "user_id", "title", "model_provider_type"
    ) VALUES
      (
        '00000000-0000-4000-8000-000000306704',
        'provider-contract-user-30671',
        'exact legacy provider',
        'vm0'
      ),
      (
        '00000000-0000-4000-8000-000000306705',
        'provider-contract-user-30671',
        'historical provider spelling',
        'VM0'
      );

    INSERT INTO "org_model_policies" (
      "id", "org_id", "model", "default_provider_type"
    ) VALUES
      (
        '00000000-0000-4000-8000-000000306706',
        'provider-contract-org-30671',
        'gpt-5.6-sol',
        'vm0'
      ),
      (
        '00000000-0000-4000-8000-000000306707',
        'provider-contract-org-30671',
        'gpt-5.6-luna',
        'VM0'
      );

    INSERT INTO "model_providers" (
      "id", "org_id", "user_id", "type", "selected_model"
    ) VALUES
      (
        '00000000-0000-4000-8000-000000306708',
        'provider-contract-org-legacy-30671',
        '__org__',
        'vm0',
        'gpt-5.6-sol'
      ),
      (
        '00000000-0000-4000-8000-000000306709',
        'provider-contract-org-historical-30671',
        '__org__',
        'VM0',
        'gpt-5.6-luna'
      );

    ALTER TABLE "agent_runs" ENABLE TRIGGER "canonicalize_agent_run_builtin_provider";
    ALTER TABLE "chat_threads" ENABLE TRIGGER "canonicalize_chat_thread_builtin_provider";
    ALTER TABLE "model_providers" ENABLE TRIGGER "canonicalize_model_provider_builtin_type";
    ALTER TABLE "org_model_policies" ENABLE TRIGGER "canonicalize_org_model_policy_builtin_provider";
  `);
}

async function validateMigrationOrdering(): Promise<void> {
  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, `${CONTRACT_MIGRATION}.sql`),
    "utf8",
  );
  const indexPreflight = migrationSql.indexOf(
    "model_providers provider-identity unique index drifted",
  );
  const collisionPreflight = migrationSql.indexOf(
    "model_providers contains a vm0/built-in identity collision",
  );
  const firstSweep = migrationSql.indexOf('UPDATE "agent_runs"');
  const zeroResidual = migrationSql.indexOf(
    "legacy vm0 provider discriminators remain after the final sweep",
  );
  const firstTriggerDrop = migrationSql.indexOf(
    'DROP TRIGGER "canonicalize_agent_run_builtin_provider"',
  );
  const firstFunctionDrop = migrationSql.indexOf(
    'DROP FUNCTION "canonicalize_agent_run_builtin_provider"',
  );

  assert.ok(indexPreflight >= 0 && indexPreflight < firstSweep);
  assert.ok(collisionPreflight >= 0 && collisionPreflight < firstSweep);
  assert.ok(firstSweep >= 0 && firstSweep < zeroResidual);
  assert.ok(zeroResidual < firstTriggerDrop);
  assert.ok(firstTriggerDrop < firstFunctionDrop);
}

async function validateFinalSweepAndRemoval(baseUrl: string): Promise<void> {
  const databaseName = "migration_test_builtin_provider_contract_30671";
  const databaseUrl = await createDatabase(baseUrl, databaseName);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await applyThrough(client, PRE_CONTRACT_MIGRATION);
    await seedFinalSweepValues(client);
    assert.equal(await bridgeObjectCount(client), 8);

    await applyThrough(client, CONTRACT_MIGRATION);

    const residuals = await client.query<{ count: number }>(`
      SELECT (
        (SELECT count(*) FROM "agent_runs" WHERE "model_provider" = 'vm0') +
        (SELECT count(*) FROM "chat_threads" WHERE "model_provider_type" = 'vm0') +
        (SELECT count(*) FROM "org_model_policies" WHERE "default_provider_type" = 'vm0') +
        (SELECT count(*) FROM "model_providers" WHERE "type" = 'vm0')
      )::integer AS "count"
    `);
    assert.deepEqual(residuals.rows, [{ count: 0 }]);

    const canonicalized = await client.query<{
      surface: string;
      type: string;
    }>(`
      SELECT 'agent_runs' AS "surface", "model_provider" AS "type"
      FROM "agent_runs"
      WHERE "id" = '00000000-0000-4000-8000-000000306702'
      UNION ALL
      SELECT 'chat_threads', "model_provider_type"
      FROM "chat_threads"
      WHERE "id" = '00000000-0000-4000-8000-000000306704'
      UNION ALL
      SELECT 'model_providers', "type"
      FROM "model_providers"
      WHERE "id" = '00000000-0000-4000-8000-000000306708'
      UNION ALL
      SELECT 'org_model_policies', "default_provider_type"
      FROM "org_model_policies"
      WHERE "id" = '00000000-0000-4000-8000-000000306706'
      ORDER BY "surface"
    `);
    assert.deepEqual(canonicalized.rows, [
      { surface: "agent_runs", type: "built-in" },
      { surface: "chat_threads", type: "built-in" },
      { surface: "model_providers", type: "built-in" },
      { surface: "org_model_policies", type: "built-in" },
    ]);

    const historicalSpellings = await client.query<{ count: number }>(`
      SELECT (
        (SELECT count(*) FROM "agent_runs" WHERE "model_provider" = 'VM0') +
        (SELECT count(*) FROM "chat_threads" WHERE "model_provider_type" = 'VM0') +
        (SELECT count(*) FROM "org_model_policies" WHERE "default_provider_type" = 'VM0') +
        (SELECT count(*) FROM "model_providers" WHERE "type" = 'VM0')
      )::integer AS "count"
    `);
    assert.deepEqual(historicalSpellings.rows, [{ count: 4 }]);
    assert.equal(await bridgeObjectCount(client), 0);

    const indexState = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS "count"
      FROM "pg_index" AS "index"
      JOIN "pg_class" AS "relation"
        ON "relation"."oid" = "index"."indexrelid"
      WHERE "index"."indrelid" = 'public.model_providers'::regclass
        AND "relation"."relname" = 'idx_model_providers_org_user_type'
        AND "index"."indisunique"
        AND "index"."indpred" IS NULL
        AND pg_get_indexdef("index"."indexrelid") = 'CREATE UNIQUE INDEX idx_model_providers_org_user_type ON public.model_providers USING btree (org_id, user_id, type)'
    `);
    assert.deepEqual(indexState.rows, [{ count: 1 }]);

    console.log(
      "   ✅ exact lowercase vm0 values are swept on all four surfaces before bridge removal",
    );
    console.log(
      "   ✅ uppercase VM0 values and the exact provider-identity index remain unchanged",
    );
    console.log("   ✅ all four triggers and four functions are absent\n");
  } finally {
    await client.end();
    await dropDatabase(baseUrl, databaseName);
  }
}

async function validateFailClosedPreflight(baseUrl: string): Promise<void> {
  const databaseName = "migration_test_builtin_provider_fail_30671";
  const databaseUrl = await createDatabase(baseUrl, databaseName);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await applyThrough(client, PRE_CONTRACT_MIGRATION);
    await client.query(`
      ALTER TABLE "model_providers" DISABLE TRIGGER "canonicalize_model_provider_builtin_type";
      INSERT INTO "model_providers" (
        "id", "org_id", "user_id", "type", "selected_model"
      ) VALUES
        (
          '00000000-0000-4000-8000-000000306710',
          'provider-contract-collision-30671',
          '__org__',
          'vm0',
          'gpt-5.6-sol'
        ),
        (
          '00000000-0000-4000-8000-000000306711',
          'provider-contract-collision-30671',
          '__org__',
          'built-in',
          'gpt-5.6-luna'
        );
      ALTER TABLE "model_providers" ENABLE TRIGGER "canonicalize_model_provider_builtin_type";
    `);

    const before = await client.query<{
      id: string;
      selectedModel: string;
      type: string;
    }>(`
      SELECT
        "id"::text AS "id",
        "selected_model" AS "selectedModel",
        "type"
      FROM "model_providers"
      WHERE "org_id" = 'provider-contract-collision-30671'
      ORDER BY "id"
    `);

    await assert.rejects(
      applyThrough(client, CONTRACT_MIGRATION),
      (error: unknown) => {
        return databaseErrorMessage(error).includes(
          "vm0/built-in identity collision",
        );
      },
    );
    const afterCollision = await client.query<{
      id: string;
      selectedModel: string;
      type: string;
    }>(`
      SELECT
        "id"::text AS "id",
        "selected_model" AS "selectedModel",
        "type"
      FROM "model_providers"
      WHERE "org_id" = 'provider-contract-collision-30671'
      ORDER BY "id"
    `);
    assert.deepEqual(afterCollision.rows, before.rows);
    assert.equal(await bridgeObjectCount(client), 8);

    await client.query(
      `DELETE FROM "model_providers" WHERE "id" = '00000000-0000-4000-8000-000000306711'`,
    );
    await client.query(`
      DROP INDEX "idx_model_providers_org_user_type";
      CREATE UNIQUE INDEX "idx_model_providers_org_user_type"
      ON "model_providers" ("org_id", "type", "user_id");
    `);

    await assert.rejects(
      applyThrough(client, CONTRACT_MIGRATION),
      (error: unknown) => {
        return databaseErrorMessage(error).includes(
          "provider-identity unique index drifted",
        );
      },
    );
    const afterIndexDrift = await client.query<{ type: string }>(`
      SELECT "type"
      FROM "model_providers"
      WHERE "id" = '00000000-0000-4000-8000-000000306710'
    `);
    assert.deepEqual(afterIndexDrift.rows, [{ type: "vm0" }]);
    assert.equal(await bridgeObjectCount(client), 8);

    console.log(
      "   ✅ vm0/built-in identity pairs fail before merging, deleting, or sweeping either row",
    );
    console.log(
      "   ✅ provider-identity index drift fails before data or bridge cleanup\n",
    );
  } finally {
    await client.end();
    await dropDatabase(baseUrl, databaseName);
  }
}

export async function validateBuiltInProviderDiscriminatorContract(
  baseUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 1.32: Validate built-in provider contract boundary ===\n",
  );
  await validateMigrationOrdering();
  await validateFinalSweepAndRemoval(baseUrl);
  await validateFailClosedPreflight(baseUrl);
}
