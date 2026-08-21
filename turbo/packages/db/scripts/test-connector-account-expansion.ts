import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0945_add_byteplus_seedream_5_pricing";
const expansionMigration = "0946_connector_account_expansion";
const contractionMigration = "0961_connector_account_lifecycle";
const testDatabase = "migration_connector_account_expansion";

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

async function expectDatabaseFailure(
  operation: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return (
      databaseErrorCode(error) === code &&
      (constraint === undefined ||
        databaseErrorConstraint(error) === constraint)
    );
  });
}

async function seedPreExpansionState(client: Client): Promise<{
  readonly ambiguousFeishuConnectionIds: readonly string[];
  readonly builtInConnectorId: string;
  readonly customHttpConnectorId: string;
  readonly customHttpDefinitionId: string;
  readonly customMcpConnectorId: string;
  readonly customMcpDefinitionId: string;
  readonly matchedFeishuConnectionId: string;
  readonly matchedFeishuConnectorId: string;
  readonly threadId: string;
  readonly unmatchedFeishuConnectionId: string;
}> {
  const orgId = "org_connector_account_expansion";
  const userId = "user_connector_account_expansion";
  const composeId = "00000000-0000-4000-8000-000000276860";
  const threadId = "00000000-0000-4000-8000-000000276861";
  const builtInConnectorId = "00000000-0000-4000-8000-000000276862";
  const customHttpDefinitionId = "00000000-0000-4000-8000-000000276863";
  const customHttpConnectorId = "00000000-0000-4000-8000-000000276864";
  const customMcpDefinitionId = "00000000-0000-4000-8000-000000276865";
  const customMcpConnectorId = "00000000-0000-4000-8000-000000276866";
  const matchedInstallationId = "00000000-0000-4000-8000-000000276867";
  const matchedFeishuDefinitionId = "00000000-0000-4000-8000-000000276868";
  const matchedFeishuConnectorId = "00000000-0000-4000-8000-000000276869";
  const matchedFeishuConnectionId = "00000000-0000-4000-8000-000000276870";
  const unmatchedFeishuConnectionId = "00000000-0000-4000-8000-000000276871";
  const ambiguousInstallationId = "00000000-0000-4000-8000-000000276872";
  const ambiguousFeishuDefinitionId = "00000000-0000-4000-8000-000000276873";
  const ambiguousFeishuConnectorId = "00000000-0000-4000-8000-000000276874";
  const ambiguousFeishuConnectionIds = [
    "00000000-0000-4000-8000-000000276875",
    "00000000-0000-4000-8000-000000276876",
  ] as const;

  await client.query("BEGIN");
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, $2, 'connector account expansion', $3)
    `,
    [composeId, userId, orgId],
  );
  await client.query(
    `
      INSERT INTO "chat_threads" ("id", "user_id", "agent_compose_id")
      VALUES ($1, $2, $3)
    `,
    [threadId, userId, composeId],
  );
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
        "mcp_endpoint",
        "mcp_transport",
        "created_by"
      ) VALUES
        (
          $1,
          $2,
          '_account-http',
          'Account HTTP',
          '["https://api.example.com/"]'::jsonb,
          '[{"key":"token","label":"Token","kind":"secret","required":true}]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.token}}"}]'::jsonb,
          '[]'::jsonb,
          'manual',
          NULL,
          NULL,
          $3
        ),
        (
          $4,
          $2,
          '_account-mcp',
          'Account MCP',
          '[]'::jsonb,
          '[{"key":"token","label":"Token","kind":"secret","required":true}]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.token}}"}]'::jsonb,
          '[]'::jsonb,
          'manual',
          'https://mcp.example.com/',
          'streamable-http',
          $3
        ),
        (
          $5,
          $2,
          '_feishu-' || $6::text,
          'Matched Feishu',
          '["https://open.feishu.cn/open-apis/"]'::jsonb,
          '[]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb,
          '[]'::jsonb,
          'oauth',
          NULL,
          NULL,
          $3
        ),
        (
          $7,
          $2,
          '_feishu-' || $8::text,
          'Ambiguous Feishu',
          '["https://open.feishu.cn/open-apis/"]'::jsonb,
          '[]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb,
          '[]'::jsonb,
          'oauth',
          NULL,
          NULL,
          $3
        )
    `,
    [
      customHttpDefinitionId,
      orgId,
      userId,
      customMcpDefinitionId,
      matchedFeishuDefinitionId,
      matchedInstallationId,
      ambiguousFeishuDefinitionId,
      ambiguousInstallationId,
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
        ($1, $2, 'feishu', 'matched-client', 'encrypted-secret',
          'https://open.feishu.cn/open-apis/authen/v1/authorize',
          'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
          'client_secret_post', 'none'),
        ($3, $2, 'feishu', 'ambiguous-client', 'encrypted-secret',
          'https://open.feishu.cn/open-apis/authen/v1/authorize',
          'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
          'client_secret_post', 'none')
    `,
    [matchedFeishuDefinitionId, orgId, ambiguousFeishuDefinitionId],
  );
  await client.query("COMMIT");
  await client.query(
    `
      INSERT INTO "connectors" (
        "id",
        "connector_slug",
        "custom_connector_id",
        "auth_method",
        "storage_version",
        "user_id",
        "org_id"
      ) VALUES
        ($1, 'github', NULL, 'oauth', 1, $2, $3),
        ($4, NULL, $5, 'manual', 1, $2, $3),
        ($6, NULL, $7, 'manual', 1, $2, $3),
        ($8, NULL, $9, 'oauth', 1, $2, $3),
        ($10, NULL, $11, 'oauth', 1, $2, $3)
    `,
    [
      builtInConnectorId,
      userId,
      orgId,
      customHttpConnectorId,
      customHttpDefinitionId,
      customMcpConnectorId,
      customMcpDefinitionId,
      matchedFeishuConnectorId,
      matchedFeishuDefinitionId,
      ambiguousFeishuConnectorId,
      ambiguousFeishuDefinitionId,
    ],
  );
  await client.query(
    `
      INSERT INTO "secrets" (
        "name", "encrypted_value", "type", "connector_id", "user_id", "org_id"
      ) VALUES ('token', 'encrypted-token', 'connector', $1, $2, $3)
    `,
    [customHttpConnectorId, userId, orgId],
  );
  await client.query(
    `
      INSERT INTO "variables" (
        "name", "value", "type", "connector_id", "user_id", "org_id"
      ) VALUES ('region', 'us-east-1', 'connector', $1, $2, $3)
    `,
    [customMcpConnectorId, userId, orgId],
  );
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
        ($1, $2, $3, $4, 'cli_account_match', 'secret', 'verify', 'encrypt', $5),
        ($6, $2, $7, $4, 'cli_account_ambiguous', 'secret', 'verify', 'encrypt', $5)
    `,
    [
      matchedInstallationId,
      orgId,
      matchedFeishuDefinitionId,
      userId,
      composeId,
      ambiguousInstallationId,
      ambiguousFeishuDefinitionId,
    ],
  );
  await client.query(
    `
      INSERT INTO "feishu_org_connections" (
        "id", "installation_id", "feishu_open_id", "user_id"
      ) VALUES
        ($1, $2, 'ou_account_match', $3),
        ($4, $2, 'ou_account_unmatched', 'user_without_connector'),
        ($5, $6, 'ou_account_ambiguous_a', $3),
        ($7, $6, 'ou_account_ambiguous_b', $3)
    `,
    [
      matchedFeishuConnectionId,
      matchedInstallationId,
      userId,
      unmatchedFeishuConnectionId,
      ambiguousFeishuConnectionIds[0],
      ambiguousInstallationId,
      ambiguousFeishuConnectionIds[1],
    ],
  );

  return {
    ambiguousFeishuConnectionIds,
    builtInConnectorId,
    customHttpConnectorId,
    customHttpDefinitionId,
    customMcpConnectorId,
    customMcpDefinitionId,
    matchedFeishuConnectionId,
    matchedFeishuConnectorId,
    threadId,
    unmatchedFeishuConnectionId,
  };
}

async function validateConnectorRows(
  client: Client,
  fixture: Awaited<ReturnType<typeof seedPreExpansionState>>,
): Promise<void> {
  const connectorRows = await client.query<{
    displayName: string | null;
    id: string;
    isDefault: boolean | null;
  }>(
    `
      SELECT
        "id",
        "display_name" AS "displayName",
        "is_default" AS "isDefault"
      FROM "connectors"
      WHERE "id" = ANY($1::uuid[])
      ORDER BY "id"
    `,
    [
      [
        fixture.builtInConnectorId,
        fixture.customHttpConnectorId,
        fixture.customMcpConnectorId,
        fixture.matchedFeishuConnectorId,
      ],
    ],
  );
  assert.equal(connectorRows.rows.length, 4);
  assert.ok(
    connectorRows.rows.every((row) => {
      return row.displayName === null && row.isDefault === true;
    }),
  );

  const dependentRows = await client.query<{
    connectorId: string;
    kind: string;
    value: string;
  }>(
    `
      SELECT
        "connector_id" AS "connectorId",
        'secret' AS "kind",
        "encrypted_value" AS "value"
      FROM "secrets"
      WHERE "connector_id" = $1
      UNION ALL
      SELECT
        "connector_id" AS "connectorId",
        'variable' AS "kind",
        "value"
      FROM "variables"
      WHERE "connector_id" = $2
      ORDER BY "kind"
    `,
    [fixture.customHttpConnectorId, fixture.customMcpConnectorId],
  );
  assert.deepEqual(dependentRows.rows, [
    {
      connectorId: fixture.customHttpConnectorId,
      kind: "secret",
      value: "encrypted-token",
    },
    {
      connectorId: fixture.customMcpConnectorId,
      kind: "variable",
      value: "us-east-1",
    },
  ]);
}

async function validateOldWriterCompatibility(
  client: Client,
  fixture: Awaited<ReturnType<typeof seedPreExpansionState>>,
): Promise<string> {
  const existingBuiltIn = await client.query<{
    id: string;
    isDefault: boolean;
  }>(
    `
      INSERT INTO "connectors" (
        "id", "connector_slug", "auth_method", "storage_version", "user_id", "org_id"
      ) VALUES (
        '00000000-0000-4000-8000-000000276877',
        'github',
        'oauth',
        2,
        'user_connector_account_expansion',
        'org_connector_account_expansion'
      )
      ON CONFLICT ("org_id", "user_id", "connector_slug")
        WHERE "connector_slug" IS NOT NULL
      DO UPDATE SET "storage_version" = excluded."storage_version"
      RETURNING "id", "is_default" AS "isDefault"
    `,
  );
  assert.deepEqual(existingBuiltIn.rows, [
    { id: fixture.builtInConnectorId, isDefault: true },
  ]);

  const existingCustom = await client.query<{
    id: string;
    isDefault: boolean;
  }>(
    `
      INSERT INTO "connectors" (
        "id", "custom_connector_id", "auth_method", "storage_version", "user_id", "org_id"
      ) VALUES (
        '00000000-0000-4000-8000-000000276880',
        $1,
        'manual',
        2,
        'user_connector_account_expansion',
        'org_connector_account_expansion'
      )
      ON CONFLICT ("org_id", "user_id", "custom_connector_id")
        WHERE "custom_connector_id" IS NOT NULL
      DO UPDATE SET "storage_version" = excluded."storage_version"
      RETURNING "id", "is_default" AS "isDefault"
    `,
    [fixture.customHttpDefinitionId],
  );
  assert.deepEqual(existingCustom.rows, [
    { id: fixture.customHttpConnectorId, isDefault: true },
  ]);

  const newConnectorId = "00000000-0000-4000-8000-000000276878";
  const inserted = await client.query<{
    displayName: string | null;
    id: string;
    isDefault: boolean;
  }>(
    `
      INSERT INTO "connectors" (
        "id", "connector_slug", "auth_method", "storage_version", "user_id", "org_id"
      ) VALUES ($1, 'slack', 'oauth', 1, 'old_writer_user', 'old_writer_org')
      RETURNING
        "id",
        "display_name" AS "displayName",
        "is_default" AS "isDefault"
    `,
    [newConnectorId],
  );
  assert.deepEqual(inserted.rows, [
    { id: newConnectorId, displayName: null, isDefault: true },
  ]);
  return newConnectorId;
}

async function validateCatalog(client: Client): Promise<void> {
  const indexes = await client.query<{ name: string }>(`
    SELECT "indexname" AS "name"
    FROM "pg_indexes"
    WHERE "schemaname" = 'public'
      AND "indexname" IN (
        'idx_connectors_org_user_slug',
        'idx_connectors_org_user_custom_connector',
        'idx_connectors_org_user_slug_default',
        'idx_connectors_org_user_custom_connector_default',
        'idx_chat_thread_connector_selections_thread_slug',
        'idx_chat_thread_connector_selections_thread_custom_connector'
      )
    ORDER BY "indexname"
  `);
  assert.deepEqual(
    indexes.rows.map((row) => {
      return row.name;
    }),
    [
      "idx_chat_thread_connector_selections_thread_custom_connector",
      "idx_chat_thread_connector_selections_thread_slug",
      "idx_connectors_org_user_custom_connector",
      "idx_connectors_org_user_custom_connector_default",
      "idx_connectors_org_user_slug",
      "idx_connectors_org_user_slug_default",
    ],
  );

  const constraints = await client.query<{ name: string }>(`
    SELECT "conname" AS "name"
    FROM "pg_constraint"
    WHERE "conname" IN (
      'idx_connectors_id_slug',
      'idx_connectors_id_custom_connector',
      'chat_thread_connector_selections_thread_connector_pk',
      'fk_chat_thread_connector_selections_connector_slug',
      'fk_chat_thread_connector_selections_custom_connector',
      'chk_chat_thread_connector_selections_target'
    )
    ORDER BY "conname"
  `);
  assert.deepEqual(
    constraints.rows.map((row) => {
      return row.name;
    }),
    [
      "chat_thread_connector_selections_thread_connector_pk",
      "chk_chat_thread_connector_selections_target",
      "fk_chat_thread_connector_selections_connector_slug",
      "fk_chat_thread_connector_selections_custom_connector",
      "idx_connectors_id_custom_connector",
      "idx_connectors_id_slug",
    ],
  );
}

async function validateSelections(
  client: Client,
  fixture: Awaited<ReturnType<typeof seedPreExpansionState>>,
): Promise<void> {
  await client.query(
    `
      INSERT INTO "chat_thread_connector_selections" (
        "chat_thread_id", "connector_id", "connector_slug"
      ) VALUES ($1, $2, 'github')
    `,
    [fixture.threadId, fixture.builtInConnectorId],
  );
  await client.query(
    `
      INSERT INTO "chat_thread_connector_selections" (
        "chat_thread_id", "connector_id", "custom_connector_id"
      ) VALUES ($1, $2, $3)
    `,
    [
      fixture.threadId,
      fixture.customHttpConnectorId,
      fixture.customHttpDefinitionId,
    ],
  );

  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "chat_thread_connector_selections" (
          "chat_thread_id", "connector_id", "connector_slug", "custom_connector_id"
        ) VALUES ($1, $2, 'github', $3)
      `,
      [
        fixture.threadId,
        fixture.builtInConnectorId,
        fixture.customHttpDefinitionId,
      ],
    ),
    "23514",
    "chk_chat_thread_connector_selections_target",
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "chat_thread_connector_selections" (
          "chat_thread_id", "connector_id"
        ) VALUES ($1, $2)
      `,
      [fixture.threadId, fixture.customMcpConnectorId],
    ),
    "23514",
    "chk_chat_thread_connector_selections_target",
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "chat_thread_connector_selections" (
          "chat_thread_id", "connector_id", "connector_slug"
        ) VALUES ($1, $2, 'slack')
      `,
      [fixture.threadId, fixture.customMcpConnectorId],
    ),
    "23503",
    "fk_chat_thread_connector_selections_connector_slug",
  );

  const otherOwnerConnectorId = "00000000-0000-4000-8000-000000276879";
  await client.query(
    `
      INSERT INTO "connectors" (
        "id", "connector_slug", "auth_method", "storage_version", "user_id", "org_id"
      ) VALUES ($1, 'github', 'oauth', 1, 'other_user', 'other_org')
    `,
    [otherOwnerConnectorId],
  );
  await expectDatabaseFailure(
    client.query(
      `
        INSERT INTO "chat_thread_connector_selections" (
          "chat_thread_id", "connector_id", "connector_slug"
        ) VALUES ($1, $2, 'github')
      `,
      [fixture.threadId, otherOwnerConnectorId],
    ),
    "23505",
    "idx_chat_thread_connector_selections_thread_slug",
  );
  await expectDatabaseFailure(
    client.query(`DELETE FROM "connectors" WHERE "id" = $1`, [
      fixture.builtInConnectorId,
    ]),
    "23503",
    "fk_chat_thread_connector_selections_connector_slug",
  );
  await expectDatabaseFailure(
    client.query(`DELETE FROM "org_custom_connectors" WHERE "id" = $1`, [
      fixture.customHttpDefinitionId,
    ]),
    "23503",
    "fk_chat_thread_connector_selections_custom_connector",
  );

  await client.query(`DELETE FROM "chat_threads" WHERE "id" = $1`, [
    fixture.threadId,
  ]);
  const remaining = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM "chat_thread_connector_selections"
  `);
  assert.deepEqual(remaining.rows, [{ count: 0 }]);
}

async function validateFeishuLinks(
  client: Client,
  fixture: Awaited<ReturnType<typeof seedPreExpansionState>>,
): Promise<void> {
  const links = await client.query<{ connectorId: string | null; id: string }>(
    `
      SELECT "id", "connector_id" AS "connectorId"
      FROM "feishu_org_connections"
      WHERE "id" = ANY($1::uuid[])
      ORDER BY "id"
    `,
    [
      [
        fixture.matchedFeishuConnectionId,
        fixture.unmatchedFeishuConnectionId,
        ...fixture.ambiguousFeishuConnectionIds,
      ],
    ],
  );
  assert.deepEqual(links.rows, [
    {
      id: fixture.matchedFeishuConnectionId,
      connectorId: fixture.matchedFeishuConnectorId,
    },
    { id: fixture.unmatchedFeishuConnectionId, connectorId: null },
    { id: fixture.ambiguousFeishuConnectionIds[0], connectorId: null },
    { id: fixture.ambiguousFeishuConnectionIds[1], connectorId: null },
  ]);

  await expectDatabaseFailure(
    client.query(
      `
        UPDATE "feishu_org_connections"
        SET "connector_id" = $1
        WHERE "id" = $2
      `,
      [fixture.matchedFeishuConnectorId, fixture.unmatchedFeishuConnectionId],
    ),
    "23505",
    "idx_feishu_org_connections_connector",
  );
  await client.query(`DELETE FROM "connectors" WHERE "id" = $1`, [
    fixture.matchedFeishuConnectorId,
  ]);
  const cleared = await client.query<{ connectorId: string | null }>(
    `
      SELECT "connector_id" AS "connectorId"
      FROM "feishu_org_connections"
      WHERE "id" = $1
    `,
    [fixture.matchedFeishuConnectionId],
  );
  assert.deepEqual(cleared.rows, [{ connectorId: null }]);
}

async function validateConnectorAccountContraction(
  client: Client,
  fixture: Awaited<ReturnType<typeof seedPreExpansionState>>,
): Promise<void> {
  const column = await client.query<{ isNullable: string }>(`
    SELECT "is_nullable" AS "isNullable"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'connectors'
      AND "column_name" = 'is_default'
  `);
  assert.deepEqual(column.rows, [{ isNullable: "NO" }]);

  const indexes = await client.query<{
    name: string;
    isUnique: boolean;
  }>(`
    SELECT
      "indexname" AS "name",
      "indexdef" LIKE 'CREATE UNIQUE INDEX%' AS "isUnique"
    FROM "pg_indexes"
    WHERE "schemaname" = 'public'
      AND "indexname" LIKE 'idx_connectors_org_user_%'
    ORDER BY "indexname"
  `);
  assert.deepEqual(indexes.rows, [
    {
      name: "idx_connectors_org_user_custom_connector",
      isUnique: false,
    },
    {
      name: "idx_connectors_org_user_custom_connector_default",
      isUnique: true,
    },
    { name: "idx_connectors_org_user_slug", isUnique: false },
    { name: "idx_connectors_org_user_slug_default", isUnique: true },
  ]);

  const siblingBuiltInId = "00000000-0000-4000-8000-000000276881";
  const siblingCustomId = "00000000-0000-4000-8000-000000276882";
  await client.query(
    `
      INSERT INTO "connectors" (
        "id", "connector_slug", "auth_method", "storage_version",
        "user_id", "org_id", "is_default"
      ) VALUES ($1, 'github', 'oauth', 1,
        'user_connector_account_expansion',
        'org_connector_account_expansion', false)
    `,
    [siblingBuiltInId],
  );
  await client.query(
    `
      INSERT INTO "connectors" (
        "id", "custom_connector_id", "auth_method", "storage_version",
        "user_id", "org_id", "is_default"
      ) VALUES ($1, $2, 'manual', 1,
        'user_connector_account_expansion',
        'org_connector_account_expansion', false)
    `,
    [siblingCustomId, fixture.customHttpDefinitionId],
  );

  await expectDatabaseFailure(
    client.query(
      `
        UPDATE "connectors"
        SET "is_default" = true
        WHERE "id" = $1
      `,
      [siblingBuiltInId],
    ),
    "23505",
    "idx_connectors_org_user_slug_default",
  );
  await expectDatabaseFailure(
    client.query(
      `
        UPDATE "connectors"
        SET "is_default" = NULL
        WHERE "id" = $1
      `,
      [siblingCustomId],
    ),
    "23502",
  );

  const defaults = await client.query<{
    connectorSlug: string | null;
    customConnectorId: string | null;
    defaultCount: number;
    totalCount: number;
  }>(`
    SELECT
      "connector_slug" AS "connectorSlug",
      "custom_connector_id" AS "customConnectorId",
      count(*) FILTER (WHERE "is_default")::integer AS "defaultCount",
      count(*)::integer AS "totalCount"
    FROM "connectors"
    WHERE "org_id" = 'org_connector_account_expansion'
      AND "user_id" = 'user_connector_account_expansion'
      AND (
        "connector_slug" = 'github'
        OR "custom_connector_id" = '${fixture.customHttpDefinitionId}'::uuid
      )
    GROUP BY "connector_slug", "custom_connector_id"
    ORDER BY "connector_slug" NULLS LAST
  `);
  assert.deepEqual(defaults.rows, [
    {
      connectorSlug: "github",
      customConnectorId: null,
      defaultCount: 1,
      totalCount: 2,
    },
    {
      connectorSlug: null,
      customConnectorId: fixture.customHttpDefinitionId,
      defaultCount: 1,
      totalCount: 2,
    },
  ]);
}

export async function validateConnectorAccountExpansion(): Promise<void> {
  console.log("=== Validate connector account expansion ===\n");

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;

  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${expansionMigration}.sql`),
    "utf8",
  );
  assert.doesNotMatch(
    migrationSql,
    /DROP INDEX "idx_connectors_org_user_(?:slug|custom_connector)"/u,
  );
  assert.doesNotMatch(migrationSql, /ALTER COLUMN "is_default" SET NOT NULL/u);
  assert.match(
    migrationSql,
    /"connector"\."custom_connector_id" = "installation"\."custom_connector_id"/u,
  );
  assert.doesNotMatch(migrationSql, /'_feishu-' \|\|/u);

  const contractionSql = await fs.readFile(
    path.join(migrationsDirectory, `${contractionMigration}.sql`),
    "utf8",
  );
  assert.match(contractionSql, /^-- vm0:non-transactional/u);
  assert.match(contractionSql, /ALTER COLUMN "is_default" SET NOT NULL/u);
  assert.match(
    contractionSql,
    /DROP INDEX CONCURRENTLY IF EXISTS "idx_connectors_org_user_slug"/u,
  );
  assert.match(
    contractionSql,
    /DROP INDEX CONCURRENTLY IF EXISTS "idx_connectors_org_user_custom_connector"/u,
  );
  assert.match(
    contractionSql,
    /CREATE INDEX CONCURRENTLY "idx_connectors_org_user_custom_connector"/u,
  );
  assert.match(
    contractionSql,
    /CREATE INDEX CONCURRENTLY "idx_connectors_org_user_slug"/u,
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
    const fixture = await seedPreExpansionState(client);
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      expansionMigration,
    );

    await validateConnectorRows(client, fixture);
    await validateOldWriterCompatibility(client, fixture);
    await validateCatalog(client);
    await validateSelections(client, fixture);
    await validateFeishuLinks(client, fixture);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      contractionMigration,
    );
    await validateConnectorAccountContraction(client, fixture);

    for (const statement of contractionSql
      .split("--> statement-breakpoint")
      .map((value) => {
        return value.trim();
      })
      .filter((value) => {
        return value.length > 0;
      })) {
      await client.query(statement);
    }

    console.log("   ✅ existing connector identities and values survive");
    console.log("   ✅ old singleton writers receive default membership");
    console.log("   ✅ exact target selection constraints fail closed");
    console.log("   ✅ selected account and definition deletion is restricted");
    console.log("   ✅ thread deletion cascades prepared selections");
    console.log(
      "   ✅ Feishu exact, unmatched, and ambiguous links are safe\n",
    );
    console.log("   ✅ account contraction is retry-safe and permits siblings");
    console.log("   ✅ non-empty targets retain one database-unique default\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateConnectorAccountExpansion().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
