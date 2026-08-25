import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import { NON_TRANSACTIONAL_MIGRATION_MARKER } from "./migration-runner";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0974_canonical_agent_writes";
const contractionMigration =
  "0975_connector_authorization_account_mutation_not_null";
const testDatabase = "migration_connector_authorization_account_mutation";

const oauthBlockerId = "00000000-0000-4000-8000-000000287261";
const oauthExplicitId = "00000000-0000-4000-8000-000000287264";
const deviceAwaitingBlockerId = "00000000-0000-4000-8000-000000287271";
const devicePollingBlockerId = "00000000-0000-4000-8000-000000287272";
const deviceExplicitId = "00000000-0000-4000-8000-000000287275";
const externalPendingBlockerId = "00000000-0000-4000-8000-000000287281";
const externalCompletingBlockerId = "00000000-0000-4000-8000-000000287282";
const externalExplicitId = "00000000-0000-4000-8000-000000287285";
const reconnectConnectionId = "00000000-0000-4000-8000-000000287299";

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectDatabaseFailure(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return databaseErrorCode(error) === code;
  });
}

async function seedLegacyAuthorizationState(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "connector_oauth_states" (
      "id",
      "state",
      "connector_slug",
      "auth_method",
      "user_id",
      "org_id",
      "redirect_uri",
      "account_mutation",
      "expires_at",
      "consumed_at"
    ) VALUES
      (
        '${oauthBlockerId}',
        'migration-oauth-blocker',
        'github',
        'oauth',
        'migration_user',
        'migration_org',
        'https://app.example.com/oauth',
        NULL,
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        NULL
      ),
      (
        '00000000-0000-4000-8000-000000287262',
        'migration-oauth-expired',
        'github',
        'oauth',
        'migration_user',
        'migration_org',
        'https://app.example.com/oauth',
        NULL,
        CURRENT_TIMESTAMP - INTERVAL '1 day',
        NULL
      ),
      (
        '00000000-0000-4000-8000-000000287263',
        'migration-oauth-consumed',
        'github',
        'oauth',
        'migration_user',
        'migration_org',
        'https://app.example.com/oauth',
        NULL,
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        CURRENT_TIMESTAMP
      ),
      (
        '${oauthExplicitId}',
        'migration-oauth-explicit',
        'github',
        'oauth',
        'migration_user',
        'migration_org',
        'https://app.example.com/oauth',
        '{"intent":"single-account"}'::jsonb,
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        NULL
      )
  `);

  await client.query(`
    INSERT INTO "connector_oauth_device_authorization_sessions" (
      "id",
      "org_id",
      "user_id",
      "connector_slug",
      "auth_method",
      "status",
      "session_token_hash",
      "encrypted_provider_state",
      "account_mutation",
      "user_code",
      "verification_uri",
      "interval_seconds",
      "expires_at",
      "completed_at"
    ) VALUES
      (
        '${deviceAwaitingBlockerId}',
        'migration_org',
        'migration_user',
        'github',
        'device',
        'awaiting_user_authorization',
        'migration-device-awaiting-blocker',
        'encrypted-state',
        NULL,
        'AWAITING',
        'https://provider.example.com/device',
        5,
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        NULL
      ),
      (
        '${devicePollingBlockerId}',
        'migration_org',
        'migration_user',
        'github',
        'device',
        'polling',
        'migration-device-polling-blocker',
        'encrypted-state',
        NULL,
        'POLLING',
        'https://provider.example.com/device',
        5,
        CURRENT_TIMESTAMP - INTERVAL '1 day',
        NULL
      ),
      (
        '00000000-0000-4000-8000-000000287273',
        'migration_org',
        'migration_user',
        'github',
        'device',
        'awaiting_user_authorization',
        'migration-device-expired',
        'encrypted-state',
        NULL,
        'EXPIRED',
        'https://provider.example.com/device',
        5,
        CURRENT_TIMESTAMP - INTERVAL '1 day',
        NULL
      ),
      (
        '00000000-0000-4000-8000-000000287274',
        'migration_org',
        'migration_user',
        'github',
        'device',
        'complete',
        'migration-device-complete',
        'encrypted-state',
        NULL,
        'COMPLETE',
        'https://provider.example.com/device',
        5,
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        CURRENT_TIMESTAMP
      ),
      (
        '${deviceExplicitId}',
        'migration_org',
        'migration_user',
        'github',
        'device',
        'awaiting_user_authorization',
        'migration-device-explicit',
        'encrypted-state',
        '{"intent":"add","displayName":"Work"}'::jsonb,
        'EXPLICIT',
        'https://provider.example.com/device',
        5,
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        NULL
      )
  `);

  await client.query(`
    INSERT INTO "connector_external_code_sessions" (
      "id",
      "org_id",
      "user_id",
      "connector_slug",
      "auth_method",
      "status",
      "session_token_hash",
      "encrypted_provider_state",
      "account_mutation",
      "authorization_url",
      "expires_at",
      "completed_at"
    ) VALUES
      (
        '${externalPendingBlockerId}',
        'migration_org',
        'migration_user',
        'aws',
        'external-code',
        'pending',
        'migration-external-pending-blocker',
        'encrypted-state',
        NULL,
        'https://provider.example.com/authorize',
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        NULL
      ),
      (
        '${externalCompletingBlockerId}',
        'migration_org',
        'migration_user',
        'aws',
        'external-code',
        'completing',
        'migration-external-completing-blocker',
        'encrypted-state',
        NULL,
        'https://provider.example.com/authorize',
        CURRENT_TIMESTAMP - INTERVAL '1 day',
        NULL
      ),
      (
        '00000000-0000-4000-8000-000000287283',
        'migration_org',
        'migration_user',
        'aws',
        'external-code',
        'pending',
        'migration-external-expired',
        'encrypted-state',
        NULL,
        'https://provider.example.com/authorize',
        CURRENT_TIMESTAMP - INTERVAL '1 day',
        NULL
      ),
      (
        '00000000-0000-4000-8000-000000287284',
        'migration_org',
        'migration_user',
        'aws',
        'external-code',
        'error',
        'migration-external-error',
        'encrypted-state',
        NULL,
        'https://provider.example.com/authorize',
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        CURRENT_TIMESTAMP
      ),
      (
        '${externalExplicitId}',
        'migration_org',
        'migration_user',
        'aws',
        'external-code',
        'pending',
        'migration-external-explicit',
        'encrypted-state',
        '{"intent":"reconnect","connectionId":"${reconnectConnectionId}"}'::jsonb,
        'https://provider.example.com/authorize',
        CURRENT_TIMESTAMP + INTERVAL '1 day',
        NULL
      )
  `);
}

async function expectBlockedMigration(client: Client): Promise<void> {
  await assert.rejects(
    applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      contractionMigration,
    ),
    (error: unknown) => {
      return (
        databaseErrorCode(error) === "P0001" &&
        error instanceof Error &&
        error.message.includes("oauth=1, device=2, external_code=2")
      );
    },
  );

  const rowCounts = await client.query<{
    rowCount: number;
    tableName: string;
  }>(`
    SELECT
      'connector_external_code_sessions' AS "tableName",
      count(*)::integer AS "rowCount"
    FROM "connector_external_code_sessions"
    WHERE "org_id" = 'migration_org'
    UNION ALL
    SELECT
      'connector_oauth_device_authorization_sessions',
      count(*)::integer
    FROM "connector_oauth_device_authorization_sessions"
    WHERE "org_id" = 'migration_org'
    UNION ALL
    SELECT
      'connector_oauth_states',
      count(*)::integer
    FROM "connector_oauth_states"
    WHERE "org_id" = 'migration_org'
    ORDER BY "tableName"
  `);
  assert.deepEqual(rowCounts.rows, [
    { tableName: "connector_external_code_sessions", rowCount: 5 },
    {
      tableName: "connector_oauth_device_authorization_sessions",
      rowCount: 5,
    },
    { tableName: "connector_oauth_states", rowCount: 4 },
  ]);

  const columns = await client.query<{
    isNullable: string;
    tableName: string;
  }>(`
    SELECT
      "table_name" AS "tableName",
      "is_nullable" AS "isNullable"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "column_name" = 'account_mutation'
      AND "table_name" IN (
        'connector_oauth_states',
        'connector_oauth_device_authorization_sessions',
        'connector_external_code_sessions'
      )
    ORDER BY "table_name"
  `);
  assert.deepEqual(columns.rows, [
    {
      tableName: "connector_external_code_sessions",
      isNullable: "YES",
    },
    {
      tableName: "connector_oauth_device_authorization_sessions",
      isNullable: "YES",
    },
    { tableName: "connector_oauth_states", isNullable: "YES" },
  ]);

  const ledger = await client.query<{ count: number }>(
    `
      SELECT count(*)::integer AS "count"
      FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = $1
    `,
    [contractionMigration],
  );
  assert.deepEqual(ledger.rows, [{ count: 0 }]);
}

async function drainBlockingFixtures(client: Client): Promise<void> {
  await client.query(
    `
      UPDATE "connector_oauth_states"
      SET "expires_at" = CURRENT_TIMESTAMP - INTERVAL '1 day'
      WHERE "id" = $1
    `,
    [oauthBlockerId],
  );
  await client.query(
    `
      UPDATE "connector_oauth_device_authorization_sessions"
      SET
        "status" = 'expired',
        "expires_at" = CURRENT_TIMESTAMP - INTERVAL '1 day',
        "completed_at" = CURRENT_TIMESTAMP
      WHERE "id" = ANY($1::uuid[])
    `,
    [[deviceAwaitingBlockerId, devicePollingBlockerId]],
  );
  await client.query(
    `
      UPDATE "connector_external_code_sessions"
      SET
        "status" = 'expired',
        "expires_at" = CURRENT_TIMESTAMP - INTERVAL '1 day',
        "completed_at" = CURRENT_TIMESTAMP
      WHERE "id" = ANY($1::uuid[])
    `,
    [[externalPendingBlockerId, externalCompletingBlockerId]],
  );
}

async function validateContractedState(client: Client): Promise<void> {
  const remainingNullRows = await client.query<{
    count: number;
    tableName: string;
  }>(`
    SELECT
      'connector_external_code_sessions' AS "tableName",
      count(*)::integer AS "count"
    FROM "connector_external_code_sessions"
    WHERE "account_mutation" IS NULL
    UNION ALL
    SELECT
      'connector_oauth_device_authorization_sessions',
      count(*)::integer
    FROM "connector_oauth_device_authorization_sessions"
    WHERE "account_mutation" IS NULL
    UNION ALL
    SELECT
      'connector_oauth_states',
      count(*)::integer
    FROM "connector_oauth_states"
    WHERE "account_mutation" IS NULL
    ORDER BY "tableName"
  `);
  assert.ok(
    remainingNullRows.rows.every((row) => {
      return row.count === 0;
    }),
  );

  const explicitRows = await client.query<{
    accountMutation: unknown;
    tableName: string;
  }>(
    `
      SELECT
        'connector_external_code_sessions' AS "tableName",
        "account_mutation" AS "accountMutation"
      FROM "connector_external_code_sessions"
      WHERE "id" = $1
      UNION ALL
      SELECT
        'connector_oauth_device_authorization_sessions',
        "account_mutation"
      FROM "connector_oauth_device_authorization_sessions"
      WHERE "id" = $2
      UNION ALL
      SELECT
        'connector_oauth_states',
        "account_mutation"
      FROM "connector_oauth_states"
      WHERE "id" = $3
      ORDER BY "tableName"
    `,
    [externalExplicitId, deviceExplicitId, oauthExplicitId],
  );
  assert.deepEqual(explicitRows.rows, [
    {
      tableName: "connector_external_code_sessions",
      accountMutation: {
        intent: "reconnect",
        connectionId: reconnectConnectionId,
      },
    },
    {
      tableName: "connector_oauth_device_authorization_sessions",
      accountMutation: { intent: "add", displayName: "Work" },
    },
    {
      tableName: "connector_oauth_states",
      accountMutation: { intent: "single-account" },
    },
  ]);

  const columns = await client.query<{
    isNullable: string;
    tableName: string;
  }>(`
    SELECT
      "table_name" AS "tableName",
      "is_nullable" AS "isNullable"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "column_name" = 'account_mutation'
      AND "table_name" IN (
        'connector_oauth_states',
        'connector_oauth_device_authorization_sessions',
        'connector_external_code_sessions'
      )
    ORDER BY "table_name"
  `);
  assert.ok(
    columns.rows.every((row) => {
      return row.isNullable === "NO";
    }),
  );

  await expectDatabaseFailure(
    client.query(`
      INSERT INTO "connector_oauth_states" (
        "state",
        "connector_slug",
        "auth_method",
        "user_id",
        "org_id",
        "redirect_uri",
        "account_mutation",
        "expires_at"
      ) VALUES (
        'migration-oauth-null-rejected',
        'github',
        'oauth',
        'migration_user',
        'migration_org',
        'https://app.example.com/oauth',
        NULL,
        CURRENT_TIMESTAMP + INTERVAL '1 day'
      )
    `),
    "23502",
  );
  await expectDatabaseFailure(
    client.query(`
      INSERT INTO "connector_oauth_device_authorization_sessions" (
        "org_id",
        "user_id",
        "connector_slug",
        "auth_method",
        "session_token_hash",
        "encrypted_provider_state",
        "account_mutation",
        "user_code",
        "verification_uri",
        "interval_seconds",
        "expires_at"
      ) VALUES (
        'migration_org',
        'migration_user',
        'github',
        'device',
        'migration-device-null-rejected',
        'encrypted-state',
        NULL,
        'REJECTED',
        'https://provider.example.com/device',
        5,
        CURRENT_TIMESTAMP + INTERVAL '1 day'
      )
    `),
    "23502",
  );
  await expectDatabaseFailure(
    client.query(`
      INSERT INTO "connector_external_code_sessions" (
        "org_id",
        "user_id",
        "connector_slug",
        "auth_method",
        "session_token_hash",
        "encrypted_provider_state",
        "account_mutation",
        "authorization_url",
        "expires_at"
      ) VALUES (
        'migration_org',
        'migration_user',
        'aws',
        'external-code',
        'migration-external-null-rejected',
        'encrypted-state',
        NULL,
        'https://provider.example.com/authorize',
        CURRENT_TIMESTAMP + INTERVAL '1 day'
      )
    `),
    "23502",
  );
}

export async function validateConnectorAuthorizationAccountMutationPresence(): Promise<void> {
  console.log(
    "=== Validate connector authorization account mutation presence ===\n",
  );

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;

  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${contractionMigration}.sql`),
    "utf8",
  );
  assert.doesNotMatch(
    migrationSql,
    new RegExp(NON_TRANSACTIONAL_MIGRATION_MARKER, "u"),
  );
  assert.match(migrationSql, /IN ACCESS EXCLUSIVE MODE/u);
  assert.match(migrationSql, /external_code=%/u);

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
    await seedLegacyAuthorizationState(client);
    await expectBlockedMigration(client);
    await drainBlockingFixtures(client);
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      contractionMigration,
    );
    await validateContractedState(client);
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      contractionMigration,
    );

    console.log("   ✅ completable null state blocks contraction atomically");
    console.log("   ✅ terminal and expired null state is removed");
    console.log("   ✅ explicit mutation JSONB survives unchanged");
    console.log("   ✅ all three columns reject null after contraction\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateConnectorAuthorizationAccountMutationPresence().catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
