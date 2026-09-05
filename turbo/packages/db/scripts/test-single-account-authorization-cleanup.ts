import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const tables = [
  "connector_oauth_states",
  "connector_oauth_device_authorization_sessions",
  "connector_external_code_sessions",
] as const;

export async function validateSingleAccountAuthorizationCleanup(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate singleton authorization-state cleanup ===");
  const migration = await readFile(
    new URL(
      "../src/migrations/1078_delete_single_account_authorization_state.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    // Connection-private copies keep the production migration SQL isolated from
    // the public tables used by concurrently running tests.
    for (const table of tables) {
      await client.query(
        `CREATE TEMP TABLE "${table}" (LIKE public."${table}" INCLUDING ALL) ON COMMIT DROP`,
      );
    }
    await client.query(migration);
    await client.query(`
      CREATE TEMP TABLE cleanup_intents ON COMMIT DROP AS
      SELECT mutation FROM (VALUES
        ('{"intent":"single-account"}'::jsonb),
        ('{"intent":"add","displayName":"Second account"}'::jsonb),
        ('{"intent":"reconnect","connectionId":"00000000-0000-4000-8000-000000000001"}'::jsonb)
      ) AS intents(mutation);
      CREATE TEMP TABLE cleanup_expiries ON COMMIT DROP AS
      SELECT CURRENT_TIMESTAMP + offset_days * INTERVAL '1 day' AS expires_at
      FROM (VALUES (-1), (1)) AS offsets(offset_days);

      INSERT INTO connector_oauth_states (
        state, connector_slug, auth_method, user_id, org_id, redirect_uri,
        account_mutation, expires_at, consumed_at
      ) SELECT
        gen_random_uuid()::text, 'github', 'oauth2', 'cleanup-user',
        'cleanup-org', 'https://example.com/callback', mutation, expires_at,
        CASE WHEN consumed THEN CURRENT_TIMESTAMP END
      FROM cleanup_intents CROSS JOIN cleanup_expiries
      CROSS JOIN (VALUES (false), (true)) AS consumption(consumed);

      INSERT INTO connector_oauth_device_authorization_sessions (
        user_id, org_id, connector_slug, auth_method, status, session_token_hash,
        encrypted_provider_state, account_mutation, user_code, verification_uri,
        interval_seconds, expires_at, completed_at
      ) SELECT
        'cleanup-user', 'cleanup-org', 'github', 'device-auth', status,
        gen_random_uuid()::text, 'fixture-provider-state', mutation,
        'fixture-user-code', 'https://example.com/device', 5, expires_at,
        CASE WHEN status IN ('complete', 'denied', 'expired', 'error')
          THEN CURRENT_TIMESTAMP END
      FROM cleanup_intents CROSS JOIN cleanup_expiries
      CROSS JOIN unnest(enum_range(
        NULL::connector_oauth_device_authorization_session_status
      )) AS statuses(status);

      INSERT INTO connector_external_code_sessions (
        user_id, org_id, connector_slug, auth_method, status, session_token_hash,
        encrypted_provider_state, account_mutation, authorization_url,
        expires_at, completed_at
      ) SELECT
        'cleanup-user', 'cleanup-org', 'github', 'external-code', status,
        gen_random_uuid()::text, 'fixture-provider-state', mutation,
        'https://example.com/authorize', expires_at,
        CASE WHEN status IN ('complete', 'expired', 'error')
          THEN CURRENT_TIMESTAMP END
      FROM cleanup_intents CROSS JOIN cleanup_expiries
      CROSS JOIN unnest(enum_range(
        NULL::connector_external_code_session_status
      )) AS statuses(status);
    `);

    const preserved = new Map<string, unknown>();
    for (const table of tables) {
      const retired = await client.query(
        `SELECT id FROM "${table}" WHERE account_mutation ->> 'intent' = 'single-account'`,
      );
      assert.ok(retired.rowCount !== null && retired.rowCount > 0);
      const explicit = await client.query(
        `SELECT * FROM "${table}" WHERE account_mutation ->> 'intent' IN ('add', 'reconnect') ORDER BY id`,
      );
      assert.ok(explicit.rowCount !== null && explicit.rowCount > 0);
      preserved.set(table, explicit.rows);
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await client.query(migration);
      for (const table of tables) {
        const remaining = await client.query(
          `SELECT * FROM "${table}" ORDER BY id`,
        );
        assert.deepStrictEqual(remaining.rows, preserved.get(table));
      }
    }
    console.log(
      "   All singleton lifecycles are removed; explicit intents and replay are unchanged",
    );
  } finally {
    await client.end();
  }
}
