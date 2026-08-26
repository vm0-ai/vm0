import assert from "node:assert/strict";

import { Client } from "pg";

type ConnectorScopeFacts = {
  readonly connectorSlug: string | null;
  readonly oauthGrantedScopes: string | null;
  readonly oauthScopes: string | null;
};

export async function validateConnectorOAuthScopeFacts(
  dbUrl: string,
): Promise<void> {
  console.log("=== Validate connector OAuth scope fact bridge ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    const customConnectorId = "00000000-0000-4000-8000-000000294650";
    await client.query(
      `INSERT INTO "org_custom_connectors" (
         "id", "org_id", "slug", "display_name", "prefix_templates",
         "header_injections", "created_by"
       ) VALUES ($1, 'oauth-scope-facts-org', '_oauth-scope-facts',
         'OAuth scope facts', '["https://example.test/"]'::jsonb,
         '[{}]'::jsonb, 'oauth-scope-facts-user')`,
      [customConnectorId],
    );
    await client.query(
      `INSERT INTO "connectors" (
         "connector_slug", "auth_method", "storage_version", "oauth_scopes",
         "oauth_granted_scopes", "user_id", "org_id"
       ) VALUES ('oauth-scope-facts', 'oauth', 1, '["requested"]',
         '["builtin-grant"]', 'oauth-scope-facts-user', 'oauth-scope-facts-org')`,
    );
    await client.query(
      `INSERT INTO "connectors" (
         "custom_connector_id", "auth_method", "storage_version",
         "oauth_scopes", "oauth_granted_scopes", "user_id", "org_id"
       ) VALUES ($1, 'manual', 1, '["custom-before"]', '["custom-grant"]',
         'oauth-scope-facts-user', 'oauth-scope-facts-org')`,
      [customConnectorId],
    );

    await client.query(
      `UPDATE "connectors"
       SET "oauth_scopes" = CASE
         WHEN "connector_slug" IS NULL THEN '["custom-after"]'
         ELSE '["old-api-requested"]'
       END
       WHERE "org_id" = 'oauth-scope-facts-org'`,
    );
    const facts = await client.query<ConnectorScopeFacts>(
      `SELECT
         "connector_slug" AS "connectorSlug",
         "oauth_scopes" AS "oauthScopes",
         "oauth_granted_scopes" AS "oauthGrantedScopes"
       FROM "connectors"
       WHERE "org_id" = 'oauth-scope-facts-org'
       ORDER BY "connector_slug" NULLS LAST`,
    );

    assert.deepEqual(facts.rows, [
      {
        connectorSlug: "oauth-scope-facts",
        oauthScopes: '["old-api-requested"]',
        oauthGrantedScopes: null,
      },
      {
        connectorSlug: null,
        oauthScopes: '["custom-after"]',
        oauthGrantedScopes: '["custom-grant"]',
      },
    ]);
    console.log("   ✅ old built-in writes invalidate stale explicit grants");
    console.log("   ✅ custom connector scope writes remain unchanged\n");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
