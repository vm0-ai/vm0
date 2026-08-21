import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0963_youthful_fenris";
const reconciliationMigration = "0964_reconcile_feishu_member_connector_links";
const testDatabase = "migration_feishu_member_connector_reconciliation";

interface ReconciliationFixture {
  readonly ambiguousConnectionId: string;
  readonly connectorIds: readonly string[];
  readonly concurrentConnectionId: string;
  readonly concurrentConnectorId: string;
  readonly concurrentDefinitionId: string;
  readonly concurrentInstallationId: string;
  readonly exactConnectionId: string;
  readonly exactConnectorId: string;
  readonly mismatchedConnectionId: string;
  readonly relinkedConnectionId: string;
  readonly relinkedConnectorId: string;
  readonly unmatchedConnectionId: string;
}

async function seedReconciliationFixture(
  client: Client,
): Promise<ReconciliationFixture> {
  const orgId = "org_feishu_member_reconciliation";
  const ownerUserId = "user_feishu_member_owner";
  const composeId = "00000000-0000-4000-8000-000000285850";
  const installationId = "00000000-0000-4000-8000-000000285851";
  const definitionId = "00000000-0000-4000-8000-000000285852";
  const exactConnectorId = "00000000-0000-4000-8000-000000285853";
  const relinkedConnectorId = "00000000-0000-4000-8000-000000285854";
  const ambiguousConnectorIds = [
    "00000000-0000-4000-8000-000000285855",
    "00000000-0000-4000-8000-000000285856",
  ] as const;
  const mismatchedConnectorId = "00000000-0000-4000-8000-000000285857";
  const unrelatedConnectorId = "00000000-0000-4000-8000-000000285858";
  const exactConnectionId = "00000000-0000-4000-8000-000000285859";
  const relinkedConnectionId = "00000000-0000-4000-8000-000000285860";
  const ambiguousConnectionId = "00000000-0000-4000-8000-000000285861";
  const unmatchedConnectionId = "00000000-0000-4000-8000-000000285862";
  const mismatchedConnectionId = "00000000-0000-4000-8000-000000285863";
  const concurrentInstallationId = "00000000-0000-4000-8000-000000285864";
  const concurrentConnectorId = "00000000-0000-4000-8000-000000285865";
  const concurrentConnectionId = "00000000-0000-4000-8000-000000285866";
  const concurrentDefinitionId = "00000000-0000-4000-8000-000000285867";

  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, $2, 'feishu-member-reconciliation', $3)
    `,
    [composeId, ownerUserId, orgId],
  );
  await client.query("BEGIN");
  await client.query(
    `
      INSERT INTO "org_custom_connectors" (
        "id",
        "org_id",
        "slug",
        "display_name",
        "prefix_templates",
        "fields",
        "header_injections",
        "query_injections",
        "auth_mode",
        "created_by"
      ) VALUES
        (
          $1,
          $2,
          '_feishu-' || $3::text,
          'Feishu member reconciliation',
          '["https://open.feishu.cn/open-apis/"]'::jsonb,
          '[]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb,
          '[]'::jsonb,
          'oauth',
          $4
        ),
        (
          $5,
          $2,
          '_feishu-' || $6::text,
          'Concurrent Feishu member reconciliation',
          '["https://open.feishu.cn/open-apis/"]'::jsonb,
          '[]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb,
          '[]'::jsonb,
          'oauth',
          $4
        )
    `,
    [
      definitionId,
      orgId,
      installationId,
      ownerUserId,
      concurrentDefinitionId,
      concurrentInstallationId,
    ],
  );
  await client.query(
    `
      INSERT INTO "org_custom_connector_oauth_configs" (
        "connector_id",
        "org_id",
        "provider_adapter",
        "client_id",
        "encrypted_client_secret",
        "authorization_url",
        "token_url",
        "token_endpoint_auth_method",
        "pkce_method"
      ) VALUES
        (
          $1,
          $2,
          'feishu',
          'feishu-member-reconciliation-client',
          'encrypted-secret',
          'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
          'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
          'client_secret_post',
          'none'
        ),
        (
          $3,
          $2,
          'feishu',
          'feishu-member-concurrent-reconciliation-client',
          'encrypted-secret',
          'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
          'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
          'client_secret_post',
          'none'
        )
    `,
    [definitionId, orgId, concurrentDefinitionId],
  );
  await client.query("COMMIT");
  await client.query(
    `
      INSERT INTO "feishu_org_installations" (
        "id",
        "org_id",
        "custom_connector_id",
        "owner_user_id",
        "app_id",
        "encrypted_app_secret",
        "encrypted_verification_token",
        "encrypted_encrypt_key",
        "default_compose_id"
      ) VALUES
        (
          $1,
          $2,
          $3,
          $4,
          'feishu-member-reconciliation-client',
          'encrypted-secret',
          'encrypted-verification',
          'encrypted-key',
          $5
        ),
        (
          $6,
          $2,
          NULL,
          $4,
          'feishu-member-concurrent-reconciliation-client',
          'encrypted-secret',
          'encrypted-verification',
          'encrypted-key',
          $5
        )
    `,
    [
      installationId,
      orgId,
      definitionId,
      ownerUserId,
      composeId,
      concurrentInstallationId,
    ],
  );
  await client.query(
    `
      INSERT INTO "connectors" (
        "id",
        "connector_slug",
        "custom_connector_id",
        "is_default",
        "auth_method",
        "storage_version",
        "external_id",
        "user_id",
        "org_id"
      ) VALUES
        ($1, NULL, $2, true, 'oauth', 1, NULL, 'user_feishu_exact', $3),
        ($4, NULL, $2, true, 'oauth', 1, 'ou_relink', 'user_feishu_relink', $3),
        ($5, NULL, $2, true, 'oauth', 1, 'ou_ambiguous', 'user_feishu_ambiguous', $3),
        ($6, NULL, $2, false, 'oauth', 1, 'ou_ambiguous', 'user_feishu_ambiguous', $3),
        ($7, NULL, $2, true, 'oauth', 1, 'ou_different', 'user_feishu_mismatch', $3),
        ($8, 'github', NULL, true, 'oauth', 1, 'external-unrelated', 'user_unrelated', $3),
        ($9, NULL, $10, true, 'oauth', 1, 'ou_concurrent', 'user_feishu_concurrent', $3)
    `,
    [
      exactConnectorId,
      definitionId,
      orgId,
      relinkedConnectorId,
      ambiguousConnectorIds[0],
      ambiguousConnectorIds[1],
      mismatchedConnectorId,
      unrelatedConnectorId,
      concurrentConnectorId,
      concurrentDefinitionId,
    ],
  );
  await client.query(
    `
      INSERT INTO "feishu_org_connections" (
        "id",
        "installation_id",
        "feishu_open_id",
        "user_id",
        "connector_id"
      ) VALUES
        ($1, $2, 'ou_exact', 'user_feishu_exact', $3),
        ($4, $2, 'ou_relink', 'user_feishu_relink', NULL),
        ($5, $2, 'ou_ambiguous', 'user_feishu_ambiguous', NULL),
        ($6, $2, 'ou_unmatched', 'user_feishu_unmatched', NULL),
        ($7, $2, 'ou_mismatch', 'user_feishu_mismatch', $8),
        ($9, $10, 'ou_concurrent', 'user_feishu_concurrent', NULL)
    `,
    [
      exactConnectionId,
      installationId,
      exactConnectorId,
      relinkedConnectionId,
      ambiguousConnectionId,
      unmatchedConnectionId,
      mismatchedConnectionId,
      mismatchedConnectorId,
      concurrentConnectionId,
      concurrentInstallationId,
    ],
  );

  return {
    ambiguousConnectionId,
    connectorIds: [
      exactConnectorId,
      relinkedConnectorId,
      ...ambiguousConnectorIds,
      mismatchedConnectorId,
      unrelatedConnectorId,
      concurrentConnectorId,
    ],
    concurrentConnectionId,
    concurrentConnectorId,
    concurrentDefinitionId,
    concurrentInstallationId,
    exactConnectionId,
    exactConnectorId,
    mismatchedConnectionId,
    relinkedConnectionId,
    relinkedConnectorId,
    unmatchedConnectionId,
  };
}

async function validateReconciledState(
  client: Client,
  fixture: ReconciliationFixture,
): Promise<void> {
  const memberRows = await client.query<{
    connectorId: string;
    externalId: string;
    id: string;
    openId: string;
  }>(
    `
      SELECT
        "feishu_connection"."id",
        "feishu_connection"."connector_id" AS "connectorId",
        "feishu_connection"."feishu_open_id" AS "openId",
        "connector"."external_id" AS "externalId"
      FROM "feishu_org_connections" AS "feishu_connection"
      INNER JOIN "connectors" AS "connector"
        ON "connector"."id" = "feishu_connection"."connector_id"
      WHERE "feishu_connection"."id" = ANY($1::uuid[])
      ORDER BY "feishu_connection"."id"
    `,
    [
      [
        fixture.exactConnectionId,
        fixture.relinkedConnectionId,
        fixture.ambiguousConnectionId,
        fixture.unmatchedConnectionId,
        fixture.mismatchedConnectionId,
        fixture.concurrentConnectionId,
      ],
    ],
  );
  assert.deepEqual(memberRows.rows, [
    {
      connectorId: fixture.exactConnectorId,
      externalId: "ou_exact",
      id: fixture.exactConnectionId,
      openId: "ou_exact",
    },
    {
      connectorId: fixture.relinkedConnectorId,
      externalId: "ou_relink",
      id: fixture.relinkedConnectionId,
      openId: "ou_relink",
    },
    {
      connectorId: fixture.concurrentConnectorId,
      externalId: "ou_concurrent",
      id: fixture.concurrentConnectionId,
      openId: "ou_concurrent",
    },
  ]);

  const connectors = await client.query<{ id: string }>(
    `
      SELECT "id"
      FROM "connectors"
      WHERE "id" = ANY($1::uuid[])
      ORDER BY "id"
    `,
    [fixture.connectorIds],
  );
  assert.deepEqual(
    connectors.rows.map((row) => {
      return row.id;
    }),
    [...fixture.connectorIds].sort(),
  );
}

async function waitForPostgresBlock(
  observer: Client,
  blockedPid: number,
  blockerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS "blocked"`,
      [blockedPid, blockerPid],
    );
    if (result.rows[0]?.blocked) {
      return;
    }
    await observer.query(`SELECT pg_sleep(0.01)`);
  }
  assert.fail("migration did not wait for the Feishu target reconciler");
}

async function applyReconciliationAfterConcurrentTargetRepair(args: {
  readonly client: Client;
  readonly connectionString: string;
  readonly fixture: ReconciliationFixture;
}): Promise<void> {
  const reconciler = new Client({ connectionString: args.connectionString });
  const observer = new Client({ connectionString: args.connectionString });
  await reconciler.connect();
  await observer.connect();
  let transactionOpen = false;
  let migration: Promise<void> | undefined;
  try {
    await reconciler.query("BEGIN");
    transactionOpen = true;
    await reconciler.query(
      `SELECT pg_advisory_xact_lock(
        hashtextextended('feishu_custom_connector:' || $1::text, 0)
      )`,
      [args.fixture.concurrentInstallationId],
    );
    await reconciler.query(
      `UPDATE "feishu_org_installations"
       SET "custom_connector_id" = $1
       WHERE "id" = $2`,
      [
        args.fixture.concurrentDefinitionId,
        args.fixture.concurrentInstallationId,
      ],
    );
    const migrationPid = await args.client.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS "pid"`,
    );
    const reconcilerPid = await reconciler.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS "pid"`,
    );
    assert.ok(migrationPid.rows[0]?.pid);
    assert.ok(reconcilerPid.rows[0]?.pid);

    migration = applyMigrationsFromDirectoryUpToTag(
      args.client,
      migrationsDirectory,
      reconciliationMigration,
    );
    await waitForPostgresBlock(
      observer,
      migrationPid.rows[0].pid,
      reconcilerPid.rows[0].pid,
    );
    await reconciler.query("COMMIT");
    transactionOpen = false;
    await migration;
  } finally {
    if (transactionOpen) {
      await reconciler.query("ROLLBACK");
    }
    await migration?.catch(() => {
      return undefined;
    });
    await observer.end();
    await reconciler.end();
  }
}

export async function validateFeishuMemberConnectorReconciliation(): Promise<void> {
  console.log("=== Validate Feishu member connector reconciliation ===\n");

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
    const fixture = await seedReconciliationFixture(client);
    await applyReconciliationAfterConcurrentTargetRepair({
      client,
      connectionString: testUrl.toString(),
      fixture,
    });
    await validateReconciledState(client, fixture);

    const migrationSql = await fs.readFile(
      path.join(migrationsDirectory, `${reconciliationMigration}.sql`),
      "utf8",
    );
    await client.query(migrationSql);
    await validateReconciledState(client, fixture);

    console.log("   ✅ exact null external identity is repaired");
    console.log("   ✅ exact external identity relinks an unclaimed member");
    console.log(
      "   ✅ ambiguous, unmatched, and mismatched members are removed",
    );
    console.log("   ✅ connector credential rows remain intact");
    console.log(
      "   ✅ migration waits for concurrent installation target repair",
    );
    console.log(
      "   ✅ reconciliation reruns without changing canonical state\n",
    );
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateFeishuMemberConnectorReconciliation().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
