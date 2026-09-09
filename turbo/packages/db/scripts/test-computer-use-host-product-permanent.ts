import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

export async function validatePermanentComputerUseHostProductState(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate Computer Use host product column state ===\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const column = await client.query(`
      SELECT "column_default", "is_nullable"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'computer_use_hosts'
        AND "column_name" = 'client_product'
    `);
    assert.deepEqual(column.rows, [
      { column_default: null, is_nullable: "YES" },
    ]);

    await client.query("BEGIN");
    const insert = `
      INSERT INTO "computer_use_hosts" (
        "org_id", "user_id", "display_name", "token_hash",
        "app_version", "os_version", "client_product"
      ) VALUES ($1, $1, 'Product invariant host', $2, '1.0.0', '14.0', $3)
      RETURNING "client_product"
    `;
    const owner = randomUUID();
    for (const product of ["zero", "okou"]) {
      const host = await client.query(insert, [owner, randomUUID(), product]);
      assert.deepEqual(host.rows, [{ client_product: product }]);
    }

    // The column is retired: #32966 stopped every read and write, so the API
    // omits it and rows land with NULL until #32967 drops the column and this
    // check constraint. Only direct SQL can exercise those remaining shapes.
    const omitted = await client.query(
      `INSERT INTO "computer_use_hosts" (
        "org_id", "user_id", "display_name", "token_hash",
        "app_version", "os_version"
      ) VALUES ($1, $1, 'Omitted product', $2, '1.0.0', '14.0')
      RETURNING "client_product"`,
      [owner, randomUUID()],
    );
    assert.deepEqual(omitted.rows, [{ client_product: null }]);

    const explicitNull = await client.query(insert, [
      owner,
      randomUUID(),
      null,
    ]);
    assert.deepEqual(explicitNull.rows, [{ client_product: null }]);

    await assert.rejects(
      client.query(insert, [owner, randomUUID(), "unknown"]),
      {
        code: "23514",
        constraint: "computer_use_hosts_client_product_check",
      },
    );
    console.log(
      "   ✅ retired product column accepts NULL; invalid identities fail\n",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
