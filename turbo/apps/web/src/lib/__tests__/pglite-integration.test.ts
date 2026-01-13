import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

describe("PGlite Integration", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    // Create in-memory PGlite instance
    client = new PGlite();
    db = drizzle({ client });
  });

  afterAll(async () => {
    await client.close();
  });

  it("should connect to PGlite and run queries", async () => {
    // Test basic query
    const result = await db.execute(sql`SELECT 1 + 1 as sum`);
    expect(result.rows[0]).toEqual({ sum: 2 });
  });

  it("should create and query a table", async () => {
    // Create a test table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS test_users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      )
    `);

    // Insert data
    await db.execute(sql`INSERT INTO test_users (name) VALUES ('Alice')`);
    await db.execute(sql`INSERT INTO test_users (name) VALUES ('Bob')`);

    // Query data
    const users = await db.execute(sql`SELECT * FROM test_users ORDER BY id`);
    expect(users.rows).toHaveLength(2);
    expect(users.rows[0]).toMatchObject({ name: "Alice" });
    expect(users.rows[1]).toMatchObject({ name: "Bob" });
  });
});
