import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { orgPlanEntitlementsCanonicalWrites } from "../src/operations/org-plan-entitlement-canonical-write";
import {
  legacyOrgPlanEntitlements,
  legacyOrgPlanEntitlementValues,
  upsertLegacyOrgPlanEntitlement,
} from "./fixtures/member-invitation-legacy-api";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const db = drizzle(client);
const schema = `invitation_retirement_${randomUUID().replaceAll("-", "")}`;

async function assertLegacyInvitation(orgId: string, expected: boolean) {
  const [row] = await db
    .select()
    .from(legacyOrgPlanEntitlements)
    .where(eq(legacyOrgPlanEntitlements.orgId, orgId));
  assert.ok(row);
  assert.equal(row.memberInvitationAllowed, expected);
}

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}", public`);
  await client.query(
    await readFile(
      new URL(
        "./fixtures/show-usage-pack-before-migration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const baseline = await readFile(
    new URL("../src/migrations/1078_baseline.sql", import.meta.url),
    "utf8",
  );
  const oldFunction = baseline.match(
    /CREATE FUNCTION public\.sync_legacy_org_plan_entitlement_member_invitation_allowed\(\)[\s\S]*?\$\$;/u,
  )?.[0];
  const oldTrigger = baseline.match(
    /CREATE TRIGGER sync_legacy_org_plan_entitlement_member_invitation_allowed[^;]+;/u,
  )?.[0];
  assert.ok(oldFunction);
  assert.ok(oldTrigger);
  await client.query(
    oldFunction.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"),
  );
  await client.query(
    oldTrigger.replace(
      "ON public.org_plan_entitlements",
      "ON org_plan_entitlements",
    ),
  );
  await client.query(
    await readFile(
      new URL("../src/migrations/1090_show_usage_pack.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query(
    await readFile(
      new URL(
        "../src/migrations/1092_retire_show_usage_pack_compatibility.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  const states = [
    ["active", true],
    ["trialing", true],
    ["past_due", true],
    ["unpaid", true],
    ["atom_grant", true],
    ["manual_active", true],
    ["suspended", false],
    ["canceled", false],
    ["unknown", false],
  ] as const;
  for (const [status, expected] of states) {
    await db.insert(legacyOrgPlanEntitlements).values({
      ...legacyOrgPlanEntitlementValues({
        orgId: `manual_${status}`,
        planKey: "free",
        source: "manual",
        memberInviteUsagePackRequired: false,
      }),
      status,
      memberInvitationAllowed: !expected,
    });
  }
  const migration = await readFile(
    new URL(
      "../src/migrations/1098_retire_member_invitation_capability.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(migration);
  for (const [status, expected] of states) {
    await assertLegacyInvitation(`manual_${status}`, expected);
  }

  // The frozen outgoing API's INSERT/ON CONFLICT and SELECT shapes stay legal.
  for (const planKey of ["free", "pro", "limited-free-1", "team"]) {
    await upsertLegacyOrgPlanEntitlement(db, {
      orgId: "outgoing_api",
      planKey,
      source: "stripe_subscription",
      memberInviteUsagePackRequired: false,
    });
    await assertLegacyInvitation("outgoing_api", true);
  }
  // An old manual override is ignored, including on INSERT ... RETURNING.
  const [legacyInserted] = await db
    .insert(legacyOrgPlanEntitlements)
    .values({
      ...legacyOrgPlanEntitlementValues({
        orgId: "old_manual",
        planKey: "free",
        source: "manual",
        memberInviteUsagePackRequired: false,
      }),
      memberInvitationAllowed: false,
    })
    .returning();
  assert.ok(legacyInserted?.memberInvitationAllowed);
  await db
    .update(legacyOrgPlanEntitlements)
    .set({ memberInvitationAllowed: false })
    .where(eq(legacyOrgPlanEntitlements.orgId, "old_manual"));
  await assertLegacyInvitation("old_manual", true);

  // Current writes omit the retired column. Old readers still see suspension
  // and reactivation, even when the plan key itself does not change.
  for (const [status, expected] of states) {
    const query = db
      .insert(orgPlanEntitlementsCanonicalWrites)
      .values({
        orgId: "current_api",
        planKey: "pro",
        planRank: 1,
        source: "manual",
        status,
        restrictedBuiltInModels: false,
      })
      .onConflictDoUpdate({
        target: orgPlanEntitlementsCanonicalWrites.orgId,
        set: { status },
      })
      .returning();
    assert.ok(!query.toSQL().sql.includes("member_invitation_allowed"));
    await query;
    await assertLegacyInvitation("current_api", expected);
  }
  console.log(
    "Member invitation retirement backfill and old/new API compatibility passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
