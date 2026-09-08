import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

export async function validatePermanentComputerUseHostProductState(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate required Computer Use host product identity ===\n");
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
      { column_default: null, is_nullable: "NO" },
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

    // The API always resolves a product; only direct SQL can exercise an
    // omitted required DB field or an identity outside the product contract.
    await client.query("SAVEPOINT required_product");
    await assert.rejects(
      client.query(
        `INSERT INTO "computer_use_hosts" (
          "org_id", "user_id", "display_name", "token_hash",
          "app_version", "os_version"
        ) VALUES ($1, $1, 'Missing product', $2, '1.0.0', '14.0')`,
        [owner, randomUUID()],
      ),
      { code: "23502", column: "client_product" },
    );
    await client.query("ROLLBACK TO SAVEPOINT required_product");

    await assert.rejects(client.query(insert, [owner, randomUUID(), null]), {
      code: "23502",
      column: "client_product",
    });
    await client.query("ROLLBACK TO SAVEPOINT required_product");

    await assert.rejects(
      client.query(insert, [owner, randomUUID(), "unknown"]),
      {
        code: "23514",
        constraint: "computer_use_hosts_client_product_check",
      },
    );
    console.log(
      "   ✅ explicit products succeed; missing/invalid identities fail\n",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
