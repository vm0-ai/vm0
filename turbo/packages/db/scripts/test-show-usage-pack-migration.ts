import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  legacyOrgPlanEntitlements,
  legacyOrgPlanEntitlementValues,
  upsertLegacyOrgPlanEntitlement,
} from "./fixtures/show-usage-pack-legacy-api";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const legacyDb = drizzle(client);
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
        await upsertLegacyOrgPlanEntitlement(legacyDb, {
          orgId,
          planKey: tier,
          source,
          memberInviteUsagePackRequired: required,
        });
        expected.push({
          org_id: orgId,
          show_usage_pack: required && (tier === "pro" || tier === "team"),
        });
      }
    }
  }
  const legacyRows = await legacyDb
    .select()
    .from(legacyOrgPlanEntitlements)
    .orderBy(legacyOrgPlanEntitlements.orgId);

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
  assert.deepEqual(
    await legacyDb
      .select()
      .from(legacyOrgPlanEntitlements)
      .orderBy(legacyOrgPlanEntitlements.orgId),
    legacyRows,
  );

  // Conflicting upserts invoke both BEFORE INSERT and BEFORE UPDATE triggers.
  // Exercise the outgoing API's complete statement without the new column.
  for (const source of sources) {
    const orgId = `old_api_${source}`;
    for (const [planKey, required, visible] of [
      ["team", true, true],
      ["limited-free-1", false, false],
      ["pro", true, true],
      ["pro", false, false],
    ] as const) {
      await upsertLegacyOrgPlanEntitlement(legacyDb, {
        orgId,
        planKey,
        source,
        memberInviteUsagePackRequired: required,
      });
      await assertVisibility(orgId, visible);
      const [legacyRow] = await legacyDb
        .select()
        .from(legacyOrgPlanEntitlements)
        .where(eq(legacyOrgPlanEntitlements.orgId, orgId));
      assert.ok(legacyRow);
      assert.equal(legacyRow.planKey, planKey);
      assert.equal(legacyRow.memberInviteUsagePackRequired, required);
    }
  }

  // Returning every old mapped column must also remain legal after migration.
  const returningValues = legacyOrgPlanEntitlementValues({
    orgId: "old_api_returning",
    planKey: "team",
    source: "stripe_atom_grant",
    memberInviteUsagePackRequired: true,
  });
  const [returned] = await legacyDb
    .insert(legacyOrgPlanEntitlements)
    .values(returningValues)
    .returning();
  assert.ok(returned);
  const { createdAt, ...returnedValues } = returned;
  assert.ok(createdAt instanceof Date);
  assert.deepEqual(returnedValues, {
    ...returningValues,
    stripeProductId: null,
    metadataVersion: "1",
    metadataHash: null,
  });
  await assertVisibility(returningValues.orgId, true);
  console.log("Usage pack visibility backfill and legacy writer checks passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
