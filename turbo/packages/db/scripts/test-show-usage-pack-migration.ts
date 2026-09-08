import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `show_usage_pack_${randomUUID().replaceAll("-", "")}`;

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE org_plan_entitlements (
      org_id text PRIMARY KEY,
      plan_key text NOT NULL,
      source text NOT NULL,
      member_invite_usage_pack_required boolean NOT NULL DEFAULT false
    )
  `);

  const expected: { org_id: string; show_usage_pack: boolean }[] = [];
  for (const source of ["stripe_subscription", "stripe_atom_grant"]) {
    for (const tier of ["pro", "team", "custom", "limited-free-1"]) {
      for (const required of [true, false]) {
        const orgId = `${source}_${tier}_${required}`;
        await client.query(
          `INSERT INTO org_plan_entitlements
             (org_id, plan_key, source, member_invite_usage_pack_required)
           VALUES ($1, $2, $3, $4)`,
          [orgId, tier, source, required],
        );
        expected.push({
          org_id: orgId,
          show_usage_pack: required && (tier === "pro" || tier === "team"),
        });
      }
    }
  }

  const migration = await readFile(
    new URL("../src/migrations/1090_show_usage_pack.sql", import.meta.url),
    "utf8",
  );
  await client.query(migration);
  const backfilled = await client.query(
    "SELECT org_id, show_usage_pack FROM org_plan_entitlements ORDER BY org_id",
  );
  assert.deepEqual(
    backfilled.rows,
    expected.sort((left, right) => {
      return left.org_id.localeCompare(right.org_id);
    }),
  );

  // An outgoing or rolled-back API omits the new column in its writes.
  await client.query(`
    INSERT INTO org_plan_entitlements
      (org_id, plan_key, source, member_invite_usage_pack_required)
    VALUES ('old_api', 'team', 'stripe_atom_grant', true)
  `);
  let result = await client.query(
    "SELECT show_usage_pack FROM org_plan_entitlements WHERE org_id = 'old_api'",
  );
  assert.deepEqual(result.rows, [{ show_usage_pack: true }]);
  await client.query(`
    UPDATE org_plan_entitlements SET plan_key = 'limited-free-1',
      member_invite_usage_pack_required = false WHERE org_id = 'old_api'
  `);
  result = await client.query(
    "SELECT show_usage_pack FROM org_plan_entitlements WHERE org_id = 'old_api'",
  );
  assert.deepEqual(result.rows, [{ show_usage_pack: false }]);
  await client.query(`
    UPDATE org_plan_entitlements SET plan_key = 'pro',
      member_invite_usage_pack_required = true WHERE org_id = 'old_api'
  `);
  result = await client.query(
    "SELECT show_usage_pack FROM org_plan_entitlements WHERE org_id = 'old_api'",
  );
  assert.deepEqual(result.rows, [{ show_usage_pack: true }]);
  console.log("Usage pack visibility backfill and legacy writer checks passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
