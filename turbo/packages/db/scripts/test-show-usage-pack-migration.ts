import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `show_usage_pack_${randomUUID().replaceAll("-", "")}`;

async function assertVisibility(orgId: string, expected: boolean) {
  const result = await client.query<{ show_usage_pack: boolean }>(
    "SELECT show_usage_pack FROM org_plan_entitlements WHERE org_id = $1",
    [orgId],
  );
  assert.deepEqual(result.rows, [{ show_usage_pack: expected }]);
}

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(
    await readFile(
      new URL(
        "./fixtures/show-usage-pack-before-migration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  const expected: { org_id: string; show_usage_pack: boolean }[] = [];
  const sources = [
    "stripe_subscription",
    "stripe_atom_grant",
    "org_metadata_bootstrap",
    "org_metadata_migration",
  ];
  for (const source of sources) {
    for (const tier of ["pro", "team", "custom", "limited-free-1"]) {
      for (const required of [true, false]) {
        const orgId = `${source}_${tier}_${required}`;
        await client.query(
          `INSERT INTO org_plan_entitlements (
            org_id, plan_key, plan_rank, source,
            member_invite_usage_pack_required, restricted_built_in_models
          ) VALUES ($1, $2, 1, $3, $4, false)`,
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
  const cleanup = await readFile(
    new URL(
      "../src/migrations/1092_retire_show_usage_pack_compatibility.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(cleanup);
  const retained = await client.query(
    "SELECT org_id, show_usage_pack FROM org_plan_entitlements ORDER BY org_id",
  );
  assert.deepEqual(retained.rows, backfilled.rows);

  // The explicit capability survives inserts and conflicting updates even when
  // the legacy invitation field has a different value.
  for (const source of sources) {
    const orgId = `explicit_visibility_${source}`;
    for (const visible of [true, false, true]) {
      await client.query(
        `INSERT INTO org_plan_entitlements (
          org_id, plan_key, plan_rank, source,
          member_invite_usage_pack_required, show_usage_pack,
          restricted_built_in_models
        ) VALUES ($1, 'pro', 1, $2, $3, $4, false)
        ON CONFLICT (org_id) DO UPDATE SET
          plan_key = EXCLUDED.plan_key,
          member_invite_usage_pack_required = EXCLUDED.member_invite_usage_pack_required,
          show_usage_pack = EXCLUDED.show_usage_pack`,
        [orgId, source, !visible, visible],
      );
      await assertVisibility(orgId, visible);
    }
  }
  console.log(
    "Usage pack backfill, retained data, and explicit writer checks passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
