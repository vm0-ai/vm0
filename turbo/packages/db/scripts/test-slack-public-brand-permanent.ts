import assert from "node:assert/strict";
import { Client } from "pg";

interface SlackPublicBrandColumn {
  readonly columnDefault: string | null;
  readonly isNullable: "NO" | "YES";
  readonly tableName: string;
}

export async function validatePermanentSlackPublicBrandState(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate permanent Slack public-brand state ===\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const columns = await client.query<SlackPublicBrandColumn>(`
      SELECT
        "table_name" AS "tableName",
        "column_default" AS "columnDefault",
        "is_nullable" AS "isNullable"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "column_name" = 'public_brand'
        AND "table_name" IN (
          'chat_slack_context',
          'slack_chat_ingress',
          'slack_org_installations'
        )
      ORDER BY "table_name"
    `);
    assert.deepEqual(columns.rows, [
      {
        columnDefault: null,
        isNullable: "NO",
        tableName: "chat_slack_context",
      },
      {
        columnDefault: null,
        isNullable: "NO",
        tableName: "slack_chat_ingress",
      },
      {
        columnDefault: "'okou'::text",
        isNullable: "NO",
        tableName: "slack_org_installations",
      },
    ]);
    console.log("   ✅ Slack ingress and context require explicit brands");
    console.log("   ✅ official Slack installations default to Okou\n");
  } finally {
    await client.end();
  }
}
