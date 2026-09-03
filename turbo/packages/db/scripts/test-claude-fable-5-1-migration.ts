import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1065_lock_default_agent_name";
const replacementMigration = "1066_migrate_claude_fable_5_to_5_1";
const testDatabase = "migration_claude_fable_5_to_5_1";

interface MigrationState {
  readonly agentReplacements: number;
  readonly customRouteCopies: number;
  readonly fallbackDefaults: number;
  readonly fallbackMembers: number;
  readonly fallbackThreads: number;
  readonly liveOldDefaults: number;
  readonly migratedDefaults: number;
  readonly migratedMembers: number;
  readonly migratedThreads: number;
  readonly modelEvents: number;
  readonly orphanDefaults: number;
  readonly orphanMembers: number;
  readonly providerReplacements: number;
  readonly queuedOldRuns: number;
  readonly residualLegacyThreadPins: number;
  readonly residualServiceTiers: number;
  readonly tierEvents: number;
}

interface ThreadEventRow {
  readonly kind: string;
  readonly selectedModel: string | null;
  readonly seqId: string;
  readonly serviceTier: string | null;
  readonly threadId: string;
}

async function seedMigrationFixture(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "org_metadata" ("org_id", "tier") VALUES
      ('org-fable-1062-built-in', 'free'),
      ('org-fable-1062-restricted', 'limited-free-1'),
      ('org-fable-1062-openrouter', 'pro'),
      ('org-fable-1062-custom', 'team');

    INSERT INTO "org_plan_entitlements" (
      "org_id",
      "plan_key",
      "plan_rank",
      "source",
      "status",
      "support_byok",
      "restricted_built_in_models"
    ) VALUES
      ('org-fable-1062-built-in', 'free', 0, 'migration-test', 'active', true, false),
      ('org-fable-1062-restricted', 'limited-free-1', 0, 'migration-test', 'active', false, true),
      ('org-fable-1062-suspended', 'pro-suspend', 0, 'migration-test', 'suspended', false, true),
      ('org-fable-1062-openrouter', 'pro', 1, 'migration-test', 'active', true, false),
      ('org-fable-1062-custom', 'team', 2, 'migration-test', 'active', true, false)
    ON CONFLICT ("org_id") DO UPDATE SET
      "plan_key" = EXCLUDED."plan_key",
      "plan_rank" = EXCLUDED."plan_rank",
      "source" = EXCLUDED."source",
      "status" = EXCLUDED."status",
      "support_byok" = EXCLUDED."support_byok",
      "restricted_built_in_models" = EXCLUDED."restricted_built_in_models";

    INSERT INTO "secrets" (
      "id", "name", "encrypted_value", "type", "user_id", "org_id"
    ) VALUES
      (
        '10620000-0000-4000-8000-000000000001',
        'openrouter',
        'encrypted',
        'user',
        '__org__',
        'org-fable-1062-openrouter'
      ),
      (
        '10620000-0000-4000-8000-000000000002',
        'custom',
        'encrypted',
        'user',
        '__org__',
        'org-fable-1062-custom'
      );

    INSERT INTO "model_providers" (
      "id", "type", "secret_id", "is_default", "selected_model", "user_id", "org_id"
    ) VALUES (
      '10620000-0000-4000-8000-000000000011',
      'openrouter-api-key',
      '10620000-0000-4000-8000-000000000001',
      true,
      'anthropic/claude-fable-5',
      '__org__',
      'org-fable-1062-openrouter'
    );

    INSERT INTO "model_provider_connections" (
      "id", "org_id", "display_name", "secret_id"
    ) VALUES (
      '10620000-0000-4000-8000-000000000021',
      'org-fable-1062-custom',
      'Migration custom gateway',
      '10620000-0000-4000-8000-000000000002'
    );

    INSERT INTO "model_provider_surfaces" (
      "id",
      "connection_id",
      "protocol",
      "api_base_url",
      "auth_header_name",
      "auth_header_template",
      "model_mappings"
    ) VALUES (
      '10620000-0000-4000-8000-000000000022',
      '10620000-0000-4000-8000-000000000021',
      'anthropic-messages',
      'https://example.com',
      'Authorization',
      'Bearer {{secret}}',
      '{
        "claude-fable-5": "upstream-fable-5",
        "claude-fable-5-1": "upstream-fable-5.1"
      }'::jsonb
    );

    INSERT INTO "org_model_policies" (
      "org_id",
      "model",
      "is_default",
      "default_provider_type",
      "credential_scope",
      "model_provider_id",
      "model_provider_surface_id"
    ) VALUES
      ('org-fable-1062-built-in', 'claude-fable-5', true, 'built-in', 'org', NULL, NULL),
      ('org-fable-1062-built-in', 'claude-fable-5-1', false, 'built-in', 'org', NULL, NULL),
      ('org-fable-1062-restricted', 'claude-fable-5', true, 'built-in', 'org', NULL, NULL),
      ('org-fable-1062-suspended', 'claude-fable-5', true, 'built-in', 'org', NULL, NULL),
      (
        'org-fable-1062-openrouter',
        'claude-fable-5',
        true,
        'openrouter-api-key',
        'org',
        '10620000-0000-4000-8000-000000000011',
        NULL
      ),
      (
        'org-fable-1062-custom',
        'claude-fable-5',
        true,
        'custom-anthropic-messages',
        'org',
        NULL,
        '10620000-0000-4000-8000-000000000022'
      ),
      ('org-fable-1062-orphan', 'claude-fable-5', true, 'built-in', 'org', NULL, NULL);

    INSERT INTO "org_members_metadata" (
      "org_id", "user_id", "selected_model", "service_tier"
    ) VALUES
      ('org-fable-1062-built-in', 'user-fable-1062-built-in', 'claude-fable-5', 'priority'),
      ('org-fable-1062-restricted', 'user-fable-1062-restricted', 'claude-fable-5', 'priority'),
      ('org-fable-1062-suspended', 'user-fable-1062-suspended', 'claude-fable-5', NULL),
      ('org-fable-1062-openrouter', 'user-fable-1062-openrouter', 'claude-fable-5', NULL),
      ('org-fable-1062-orphan', 'user-fable-1062-orphan', 'claude-fable-5', NULL);

    INSERT INTO "agents" (
      "id", "org_id", "owner", "name", "model_provider_id", "selected_model"
    ) VALUES
      (
        '10620000-0000-4000-8000-000000000101',
        'org-fable-1062-built-in',
        'user-fable-1062-built-in',
        'built-in',
        NULL,
        NULL
      ),
      (
        '10620000-0000-4000-8000-000000000102',
        'org-fable-1062-restricted',
        'user-fable-1062-restricted',
        'restricted',
        NULL,
        'claude-fable-5'
      ),
      (
        '10620000-0000-4000-8000-000000000103',
        'org-fable-1062-suspended',
        'user-fable-1062-suspended',
        'suspended',
        NULL,
        NULL
      ),
      (
        '10620000-0000-4000-8000-000000000104',
        'org-fable-1062-openrouter',
        'user-fable-1062-openrouter',
        'openrouter',
        '10620000-0000-4000-8000-000000000011',
        'anthropic/claude-fable-5'
      );

    INSERT INTO "chat_threads" (
      "id",
      "user_id",
      "agent_id",
      "selected_model",
      "codex_service_tier",
      "model_provider_type",
      "model_provider_credential_scope"
    ) VALUES
      (
        '10620000-0000-4000-8000-000000000201',
        'user-fable-1062-built-in',
        '10620000-0000-4000-8000-000000000101',
        'claude-fable-5',
        'fast',
        'built-in',
        'org'
      ),
      (
        '10620000-0000-4000-8000-000000000202',
        'user-fable-1062-restricted',
        '10620000-0000-4000-8000-000000000102',
        'claude-fable-5',
        NULL,
        'built-in',
        'org'
      ),
      (
        '10620000-0000-4000-8000-000000000203',
        'user-fable-1062-suspended',
        '10620000-0000-4000-8000-000000000103',
        'claude-fable-5',
        NULL,
        NULL,
        NULL
      ),
      (
        '10620000-0000-4000-8000-000000000204',
        'user-fable-1062-openrouter',
        '10620000-0000-4000-8000-000000000104',
        'claude-fable-5',
        NULL,
        'openrouter-api-key',
        'org'
      );

    INSERT INTO "agent_sessions" ("id", "user_id", "org_id", "agent_id")
    VALUES (
      '10620000-0000-4000-8000-000000000301',
      'user-fable-1062-built-in',
      'org-fable-1062-built-in',
      '10620000-0000-4000-8000-000000000101'
    );

    INSERT INTO "agent_runs" (
      "id",
      "user_id",
      "session_id",
      "status",
      "prompt",
      "org_id",
      "trigger_source",
      "autonomy_budget",
      "model_provider",
      "model_provider_credential_scope",
      "selected_model"
    ) VALUES (
      '10620000-0000-4000-8000-000000000401',
      'user-fable-1062-built-in',
      '10620000-0000-4000-8000-000000000301',
      'queued',
      'Queued run remains immutable',
      'org-fable-1062-built-in',
      'web',
      0,
      'built-in',
      'org',
      'claude-fable-5'
    );

    INSERT INTO "agent_run_queue" (
      "run_id", "user_id", "created_at", "expires_at", "org_id"
    ) VALUES (
      '10620000-0000-4000-8000-000000000401',
      'user-fable-1062-built-in',
      now(),
      now() + interval '1 hour',
      'org-fable-1062-built-in'
    );
  `);
}

async function readMigrationState(client: Client): Promise<MigrationState> {
  const result = await client.query<MigrationState>(`
    SELECT
      (
        SELECT count(*)::integer
        FROM "org_model_policies"
        WHERE "org_id" LIKE 'org-fable-1062-%'
          AND "org_id" NOT IN (
            'org-fable-1062-orphan',
            'org-fable-1062-restricted'
          )
          AND "model" = 'claude-fable-5-1'
          AND "is_default"
      ) AS "migratedDefaults",
      (
        SELECT count(*)::integer
        FROM "org_model_policies"
        WHERE "org_id" = 'org-fable-1062-restricted'
          AND "model" = 'deepseek-v4-flash'
          AND "is_default"
          AND "default_provider_type" = 'built-in'
      ) AS "fallbackDefaults",
      (
        SELECT count(*)::integer
        FROM "org_model_policies"
        WHERE "org_id" LIKE 'org-fable-1062-%'
          AND "org_id" NOT IN (
            'org-fable-1062-orphan',
            'org-fable-1062-invalid-custom'
          )
          AND "model" = 'claude-fable-5'
          AND "is_default"
      ) AS "liveOldDefaults",
      (
        SELECT count(*)::integer
        FROM "org_model_policies"
        WHERE "org_id" = 'org-fable-1062-orphan'
          AND "model" = 'claude-fable-5'
          AND "is_default"
      ) AS "orphanDefaults",
      (
        SELECT count(*)::integer
        FROM "org_model_policies"
        WHERE "org_id" = 'org-fable-1062-custom'
          AND "model" = 'claude-fable-5-1'
          AND "model_provider_surface_id" =
            '10620000-0000-4000-8000-000000000022'
      ) AS "customRouteCopies",
      (
        SELECT count(*)::integer
        FROM "org_members_metadata"
        WHERE "org_id" LIKE 'org-fable-1062-%'
          AND "org_id" NOT IN (
            'org-fable-1062-orphan',
            'org-fable-1062-restricted'
          )
          AND "selected_model" = 'claude-fable-5-1'
          AND "service_tier" IS NULL
      ) AS "migratedMembers",
      (
        SELECT count(*)::integer
        FROM "org_members_metadata"
        WHERE "org_id" = 'org-fable-1062-restricted'
          AND "selected_model" = 'deepseek-v4-flash'
          AND "service_tier" IS NULL
      ) AS "fallbackMembers",
      (
        SELECT count(*)::integer
        FROM "org_members_metadata"
        WHERE "org_id" = 'org-fable-1062-orphan'
          AND "selected_model" = 'claude-fable-5'
      ) AS "orphanMembers",
      (
        SELECT count(*)::integer
        FROM "chat_threads"
        WHERE "id" IN (
          '10620000-0000-4000-8000-000000000201',
          '10620000-0000-4000-8000-000000000203',
          '10620000-0000-4000-8000-000000000204'
        )
          AND "selected_model" = 'claude-fable-5-1'
      ) AS "migratedThreads",
      (
        SELECT count(*)::integer
        FROM "chat_threads"
        WHERE "id" = '10620000-0000-4000-8000-000000000202'
          AND "selected_model" = 'deepseek-v4-flash'
      ) AS "fallbackThreads",
      (
        SELECT count(*)::integer
        FROM "chat_threads"
        WHERE "id"::text LIKE '10620000-0000-4000-8000-0000000002%'
          AND (
            "model_provider_id" IS NOT NULL
            OR "model_provider_type" IS NOT NULL
            OR "model_provider_credential_scope" IS NOT NULL
          )
      ) AS "residualLegacyThreadPins",
      (
        SELECT count(*)::integer
        FROM "chat_threads"
        WHERE "id"::text LIKE '10620000-0000-4000-8000-0000000002%'
          AND "codex_service_tier" IS NOT NULL
      ) AS "residualServiceTiers",
      (
        SELECT count(*)::integer
        FROM "chat_thread_events"
        WHERE "chat_thread_id"::text LIKE
          '10620000-0000-4000-8000-0000000002%'
          AND "kind" = 'model_selection_updated'
      ) AS "modelEvents",
      (
        SELECT count(*)::integer
        FROM "chat_thread_events"
        WHERE "chat_thread_id"::text LIKE
          '10620000-0000-4000-8000-0000000002%'
          AND "kind" = 'service_tier_updated'
          AND "service_tier" IS NULL
      ) AS "tierEvents",
      (
        SELECT count(*)::integer
        FROM "agents"
        WHERE (
          "id" = '10620000-0000-4000-8000-000000000102'
          AND "selected_model" = 'deepseek-v4-flash'
          AND "model_provider_id" IS NULL
        ) OR (
          "id" = '10620000-0000-4000-8000-000000000104'
          AND "selected_model" = 'anthropic/claude-fable-5.1'
        )
      ) AS "agentReplacements",
      (
        SELECT count(*)::integer
        FROM "model_providers"
        WHERE "id" = '10620000-0000-4000-8000-000000000011'
          AND "selected_model" = 'anthropic/claude-fable-5.1'
      ) AS "providerReplacements",
      (
        SELECT count(*)::integer
        FROM "agent_runs" AS run
        INNER JOIN "agent_run_queue" AS queue
          ON queue."run_id" = run."id"
        WHERE run."id" = '10620000-0000-4000-8000-000000000401'
          AND run."selected_model" = 'claude-fable-5'
      ) AS "queuedOldRuns"
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function readThreadEvents(
  client: Client,
): Promise<readonly ThreadEventRow[]> {
  const result = await client.query<ThreadEventRow>(`
    SELECT
      "chat_thread_id"::text AS "threadId",
      "kind"::text AS "kind",
      "seq_id"::text AS "seqId",
      "selected_model" AS "selectedModel",
      "service_tier" AS "serviceTier"
    FROM "chat_thread_events"
    WHERE "chat_thread_id"::text LIKE
      '10620000-0000-4000-8000-0000000002%'
    ORDER BY "chat_thread_id", "seq_id"
  `);
  return result.rows;
}

function assertMigratedState(state: MigrationState): void {
  assert.deepEqual(state, {
    agentReplacements: 2,
    customRouteCopies: 1,
    fallbackDefaults: 1,
    fallbackMembers: 1,
    fallbackThreads: 1,
    liveOldDefaults: 0,
    migratedDefaults: 4,
    migratedMembers: 3,
    migratedThreads: 3,
    modelEvents: 4,
    orphanDefaults: 1,
    orphanMembers: 1,
    providerReplacements: 1,
    queuedOldRuns: 1,
    residualLegacyThreadPins: 0,
    residualServiceTiers: 0,
    tierEvents: 1,
  });
}

async function assertInvalidCustomRouteFailsClosed(
  client: Client,
  migrationSql: string,
): Promise<void> {
  await client.query(`
    INSERT INTO "org_metadata" ("org_id", "tier")
    VALUES ('org-fable-1062-invalid-custom', 'team');

    INSERT INTO "org_plan_entitlements" (
      "org_id",
      "plan_key",
      "plan_rank",
      "source",
      "status",
      "support_byok",
      "restricted_built_in_models"
    ) VALUES (
      'org-fable-1062-invalid-custom',
      'team',
      2,
      'migration-test',
      'active',
      true,
      false
    )
    ON CONFLICT ("org_id") DO UPDATE SET
      "plan_key" = EXCLUDED."plan_key",
      "plan_rank" = EXCLUDED."plan_rank",
      "source" = EXCLUDED."source",
      "status" = EXCLUDED."status",
      "support_byok" = EXCLUDED."support_byok",
      "restricted_built_in_models" = EXCLUDED."restricted_built_in_models";

    INSERT INTO "secrets" (
      "id", "name", "encrypted_value", "type", "user_id", "org_id"
    ) VALUES (
      '10620000-0000-4000-8000-000000000501',
      'invalid-custom',
      'encrypted',
      'user',
      '__org__',
      'org-fable-1062-invalid-custom'
    );

    INSERT INTO "model_provider_connections" (
      "id", "org_id", "display_name", "secret_id"
    ) VALUES (
      '10620000-0000-4000-8000-000000000502',
      'org-fable-1062-invalid-custom',
      'Invalid migration custom gateway',
      '10620000-0000-4000-8000-000000000501'
    );

    INSERT INTO "model_provider_surfaces" (
      "id",
      "connection_id",
      "protocol",
      "api_base_url",
      "auth_header_name",
      "auth_header_template",
      "model_mappings"
    ) VALUES (
      '10620000-0000-4000-8000-000000000503',
      '10620000-0000-4000-8000-000000000502',
      'anthropic-messages',
      'https://invalid.example.com',
      'Authorization',
      'Bearer {{secret}}',
      '{"claude-fable-5": "upstream-fable-5"}'::jsonb
    );

    INSERT INTO "org_model_policies" (
      "org_id",
      "model",
      "is_default",
      "default_provider_type",
      "credential_scope",
      "model_provider_surface_id"
    ) VALUES (
      'org-fable-1062-invalid-custom',
      'claude-fable-5',
      true,
      'custom-anthropic-messages',
      'org',
      '10620000-0000-4000-8000-000000000503'
    );
  `);

  await assert.rejects(
    client.query(migrationSql),
    /requires valid successor policies/iu,
  );
  const invalidPolicy = await client.query<{
    isDefault: boolean;
    model: string;
  }>(`
    SELECT "model", "is_default" AS "isDefault"
    FROM "org_model_policies"
    WHERE "org_id" = 'org-fable-1062-invalid-custom'
    ORDER BY "model"
  `);
  assert.deepEqual(invalidPolicy.rows, [
    { isDefault: true, model: "claude-fable-5" },
  ]);
}

export async function validateClaudeFable51Migration(): Promise<void> {
  console.log("=== Validate Claude Fable 5 to 5.1 migration ===\n");

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;

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
    await seedMigrationFixture(client);
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      replacementMigration,
    );
    assertMigratedState(await readMigrationState(client));

    const migrationSql = await fs.readFile(
      path.join(migrationsDirectory, `${replacementMigration}.sql`),
      "utf8",
    );
    const events = await readThreadEvents(client);
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((event) => {
        return event.seqId;
      }),
      ["1", "2", "1", "1", "1"],
    );

    await client.query(migrationSql);
    assertMigratedState(await readMigrationState(client));
    assert.deepEqual(await readThreadEvents(client), events);

    await assertInvalidCustomRouteFailsClosed(client, migrationSql);
    assertMigratedState(await readMigrationState(client));
    assert.deepEqual(await readThreadEvents(client), events);

    console.log(
      "   ✅ valid built-in, direct, and custom routes reach Fable 5.1",
    );
    console.log(
      "   ✅ active restricted state falls back to built-in DeepSeek",
    );
    console.log(
      "   ✅ thread model and tier events receive monotonic sequence IDs",
    );
    console.log(
      "   ✅ queued run snapshots and orphaned organization state stay intact",
    );
    console.log(
      "   ✅ invalid custom mappings abort and reruns add no events\n",
    );
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateClaudeFable51Migration().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
