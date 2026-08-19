import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0946_connector_account_expansion";
const reclassifyMigration = "0947_custom_model_gateway_provider_types";
const testDatabase = "migration_custom_gateway_provider_types";

const CUSTOM_ORG = "org_custom_gateway_reclassify";
const VERCEL_ORG = "org_genuine_vercel_byok";

const ids = {
  customCompose: "00000000-0000-4000-8000-000000094801",
  customSession: "00000000-0000-4000-8000-000000094802",
  customSecret: "00000000-0000-4000-8000-000000094803",
  customConnection: "00000000-0000-4000-8000-000000094804",
  messagesSurface: "00000000-0000-4000-8000-000000094805",
  responsesSurface: "00000000-0000-4000-8000-000000094806",
  vercelCompose: "00000000-0000-4000-8000-000000094807",
  vercelSession: "00000000-0000-4000-8000-000000094808",
  vercelSecret: "00000000-0000-4000-8000-000000094809",
  vercelMessagesProvider: "00000000-0000-4000-8000-000000094810",
  vercelResponsesProvider: "00000000-0000-4000-8000-000000094811",
  // Points at neither model_providers nor model_provider_surfaces.
  danglingProvider: "00000000-0000-4000-8000-000000094812",
  runSurfaceMessages: "00000000-0000-4000-8000-000000094820",
  runSurfaceResponses: "00000000-0000-4000-8000-000000094821",
  runLegacyMessages: "00000000-0000-4000-8000-000000094822",
  runLegacyResponses: "00000000-0000-4000-8000-000000094823",
  runNoProviderId: "00000000-0000-4000-8000-000000094824",
  runDanglingProviderId: "00000000-0000-4000-8000-000000094825",
  runUnrelatedProviderType: "00000000-0000-4000-8000-000000094826",
} as const;

async function seedPreReclassifyState(client: Client): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id") VALUES
        ($1, 'custom-gateway-user', 'custom-gateway-agent', $3),
        ($2, 'genuine-vercel-user', 'genuine-vercel-agent', $4)
    `,
    [ids.customCompose, ids.vercelCompose, CUSTOM_ORG, VERCEL_ORG],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      ) VALUES
        ($1, 'custom-gateway-user', $3, $5),
        ($2, 'genuine-vercel-user', $4, $6)
    `,
    [
      ids.customSession,
      ids.vercelSession,
      CUSTOM_ORG,
      VERCEL_ORG,
      ids.customCompose,
      ids.vercelCompose,
    ],
  );
  await client.query(
    `
      INSERT INTO "secrets" (
        "id", "name", "encrypted_value", "type", "user_id", "org_id"
      ) VALUES
        ($1, 'custom-gateway-secret', 'fixture', 'user', 'custom-gateway-user', $3),
        ($2, 'genuine-vercel-secret', 'fixture', 'user', '__org__', $4)
    `,
    [ids.customSecret, ids.vercelSecret, CUSTOM_ORG, VERCEL_ORG],
  );

  // A genuine Vercel AI Gateway BYOK org routes through `model_providers`.
  await client.query(
    `
      INSERT INTO "model_providers" (
        "id", "type", "secret_id", "is_default", "selected_model",
        "user_id", "org_id"
      ) VALUES
        ($1, 'vercel-ai-gateway', $3, true, 'anthropic/claude-sonnet-5', '__org__', $4),
        ($2, 'vercel-ai-gateway-codex', $3, false, 'openai/gpt-5.6-sol', '__org__', $4)
    `,
    [
      ids.vercelMessagesProvider,
      ids.vercelResponsesProvider,
      ids.vercelSecret,
      VERCEL_ORG,
    ],
  );

  // A custom gateway org routes through `model_provider_surfaces`.
  await client.query(
    `
      INSERT INTO "model_provider_connections" (
        "id", "org_id", "display_name", "secret_id"
      ) VALUES ($1, $2, 'Self-hosted gateway', $3)
    `,
    [ids.customConnection, CUSTOM_ORG, ids.customSecret],
  );
  await client.query(
    `
      INSERT INTO "model_provider_surfaces" (
        "id", "connection_id", "protocol", "api_base_url",
        "auth_header_name", "auth_header_template", "model_mappings"
      ) VALUES
        (
          $1, $3, 'anthropic-messages', 'https://tunnel.example.test',
          'Authorization', 'Bearer {{secret}}',
          '{"claude-sonnet-5":"company-sonnet"}'::jsonb
        ),
        (
          $2, $3, 'openai-responses', 'https://tunnel.example.test/v1',
          'Authorization', 'Bearer {{secret}}',
          '{"deepseek-v4-flash":"deepseek-v4-flash-0731"}'::jsonb
        )
    `,
    [ids.messagesSurface, ids.responsesSurface, ids.customConnection],
  );

  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt",
        "trigger_source", "autonomy_budget", "model_provider",
        "model_provider_id", "model_provider_credential_scope",
        "selected_model"
      ) VALUES
        (
          $1, 'custom-gateway-user', $8, $10, 'completed', 'custom messages run',
          'chat', 0, 'vercel-ai-gateway', $12, 'org', 'claude-sonnet-5'
        ),
        (
          $2, 'custom-gateway-user', $8, $10, 'completed', 'custom responses run',
          'chat', 0, 'vercel-ai-gateway-codex', $13, 'org', 'deepseek-v4-flash'
        ),
        (
          $3, 'genuine-vercel-user', $9, $11, 'completed', 'genuine vercel run',
          'chat', 0, 'vercel-ai-gateway', $14, 'org', 'anthropic/claude-sonnet-5'
        ),
        (
          $4, 'genuine-vercel-user', $9, $11, 'completed', 'genuine vercel codex run',
          'chat', 0, 'vercel-ai-gateway-codex', $15, 'org', 'openai/gpt-5.6-sol'
        ),
        (
          $5, 'genuine-vercel-user', $9, $11, 'completed', 'no provider id run',
          'chat', 0, 'vercel-ai-gateway', NULL, 'org', 'anthropic/claude-sonnet-5'
        ),
        (
          $6, 'custom-gateway-user', $8, $10, 'completed', 'dangling provider id run',
          'chat', 0, 'vercel-ai-gateway-codex', $16, 'org', 'deepseek-v4-flash'
        ),
        (
          $7, 'custom-gateway-user', $8, $10, 'completed', 'unrelated provider type run',
          'chat', 0, 'openrouter-api-key', $12, 'org', 'claude-sonnet-5'
        )
    `,
    [
      ids.runSurfaceMessages,
      ids.runSurfaceResponses,
      ids.runLegacyMessages,
      ids.runLegacyResponses,
      ids.runNoProviderId,
      ids.runDanglingProviderId,
      ids.runUnrelatedProviderType,
      CUSTOM_ORG,
      VERCEL_ORG,
      ids.customSession,
      ids.vercelSession,
      ids.messagesSurface,
      ids.responsesSurface,
      ids.vercelMessagesProvider,
      ids.vercelResponsesProvider,
      ids.danglingProvider,
    ],
  );

  await client.query(
    `
      INSERT INTO "org_model_policies" (
        "org_id", "model", "is_default", "default_provider_type",
        "credential_scope", "model_provider_id", "model_provider_surface_id"
      ) VALUES
        ($1, 'claude-sonnet-5', true, 'vercel-ai-gateway', 'org', NULL, $3),
        ($1, 'deepseek-v4-flash', false, 'vercel-ai-gateway-codex', 'org', NULL, $4),
        ($2, 'claude-sonnet-5', true, 'vercel-ai-gateway', 'org', $5, NULL),
        ($2, 'gpt-5.6-sol', false, 'vercel-ai-gateway-codex', 'org', $6, NULL)
    `,
    [
      CUSTOM_ORG,
      VERCEL_ORG,
      ids.messagesSurface,
      ids.responsesSurface,
      ids.vercelMessagesProvider,
      ids.vercelResponsesProvider,
    ],
  );
  await client.query("COMMIT");
}

async function validateRunReclassification(client: Client): Promise<void> {
  const runs = await client.query<{ id: string; modelProvider: string }>(`
    SELECT "id", "model_provider" AS "modelProvider"
    FROM "agent_runs"
    ORDER BY "id"
  `);
  assert.deepEqual(runs.rows, [
    { id: ids.runSurfaceMessages, modelProvider: "custom-anthropic-messages" },
    { id: ids.runSurfaceResponses, modelProvider: "custom-openai-responses" },
    { id: ids.runLegacyMessages, modelProvider: "vercel-ai-gateway" },
    { id: ids.runLegacyResponses, modelProvider: "vercel-ai-gateway-codex" },
    { id: ids.runNoProviderId, modelProvider: "vercel-ai-gateway" },
    { id: ids.runDanglingProviderId, modelProvider: "vercel-ai-gateway-codex" },
    { id: ids.runUnrelatedProviderType, modelProvider: "openrouter-api-key" },
  ]);
}

async function validatePolicyReclassification(client: Client): Promise<void> {
  const policies = await client.query<{
    orgId: string;
    model: string;
    providerType: string;
  }>(`
    SELECT
      "org_id" AS "orgId",
      "model",
      "default_provider_type" AS "providerType"
    FROM "org_model_policies"
    ORDER BY "org_id", "model"
  `);
  assert.deepEqual(policies.rows, [
    {
      orgId: CUSTOM_ORG,
      model: "claude-sonnet-5",
      providerType: "custom-anthropic-messages",
    },
    {
      orgId: CUSTOM_ORG,
      model: "deepseek-v4-flash",
      providerType: "custom-openai-responses",
    },
    {
      orgId: VERCEL_ORG,
      model: "claude-sonnet-5",
      providerType: "vercel-ai-gateway",
    },
    {
      orgId: VERCEL_ORG,
      model: "gpt-5.6-sol",
      providerType: "vercel-ai-gateway-codex",
    },
  ]);
}

export async function validateCustomGatewayProviderTypes(): Promise<void> {
  console.log(
    "=== Validate custom gateway provider type reclassification ===\n",
  );

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;

  // `model_provider_id` also stores legacy `model_providers` ids, so a
  // nullability predicate would rewrite genuine Vercel BYOK history.
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${reclassifyMigration}.sql`),
    "utf8",
  );
  assert.doesNotMatch(migrationSql, /"model_provider_id" IS NOT NULL/u);
  assert.equal(
    migrationSql.match(
      /"model_provider_id" IN \(SELECT "id" FROM "model_provider_surfaces"\)/gu,
    )?.length,
    2,
  );

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
    await seedPreReclassifyState(client);
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      reclassifyMigration,
    );

    await validateRunReclassification(client);
    await validatePolicyReclassification(client);

    console.log("   ✅ surface-routed runs report the custom gateway types");
    console.log("   ✅ legacy Vercel BYOK runs keep their vendor type");
    console.log("   ✅ null and dangling provider ids are left untouched");
    console.log("   ✅ surface-routed policies follow the same rule\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateCustomGatewayProviderTypes().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
