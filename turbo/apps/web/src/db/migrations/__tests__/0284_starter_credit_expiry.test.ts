import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { initServices } from "../../../lib/init-services";

/**
 * Integration test for the migration 0284 backfill body.
 *
 * The migration itself has already run against the test DB, so re-running
 * the DDL is not possible. Instead, we seed the DB with orgs that look like
 * they pre-date the backfill (free-tier, no starter_grant row), execute the
 * backfill's INSERT…SELECT body verbatim, and assert the filter semantics.
 */

const context = testContext();

async function seedOrg(
  orgId: string,
  tier: "free" | "pro",
  credits: number,
): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  await globalThis.services.db
    .insert(orgMetadata)
    .values({ orgId, tier, credits })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { tier, credits, updatedAt: new Date() },
    });
}

async function clearStarterGrants(orgId: string): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: isolates each run
  await globalThis.services.db
    .delete(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        eq(creditExpiresRecord.source, "starter_grant"),
      ),
    );
}

async function readStarterGrants(orgId: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  return globalThis.services.db
    .select()
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        eq(creditExpiresRecord.source, "starter_grant"),
      ),
    );
}

async function runBackfill(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the verbatim backfill body
  await globalThis.services.db.execute(sql`
    INSERT INTO "credit_expires_record" (
      id, org_id, source, stripe_invoice_id, amount, remaining, expires_at, created_at
    )
    SELECT
      gen_random_uuid(),
      org_id,
      'starter_grant',
      NULL,
      credits,
      credits,
      now() + interval '1 month',
      now()
    FROM "org_metadata" om
    WHERE tier = 'free'
      AND credits > 0
      AND NOT EXISTS (
        SELECT 1 FROM "credit_expires_record" cer
        WHERE cer.org_id = om.org_id
          AND cer.source = 'starter_grant'
      )
  `);
}

describe("migration 0284 backfill body", () => {
  beforeEach(() => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised to run raw SQL
    initServices();
  });

  it("backfills a free-tier org with partial balance (< 100k)", async () => {
    const orgId = uniqueId("org-backfill-50k");
    await seedOrg(orgId, "free", 50_000);
    await clearStarterGrants(orgId);

    await runBackfill();

    const rows = await readStarterGrants(orgId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.amount).toBe(50_000);
    expect(row.remaining).toBe(50_000);
    expect(row.stripeInvoiceId).toBeNull();
  });

  it("tags the full balance as expiring for free orgs with > 100k credits", async () => {
    const orgId = uniqueId("org-backfill-over");
    await seedOrg(orgId, "free", 250_000);
    await clearStarterGrants(orgId);

    await runBackfill();

    const rows = await readStarterGrants(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(250_000);
    expect(rows[0]!.remaining).toBe(250_000);
  });

  it("skips free-tier orgs with 0 balance — no retroactive grants", async () => {
    const orgId = uniqueId("org-backfill-zero");
    await seedOrg(orgId, "free", 0);
    await clearStarterGrants(orgId);

    await runBackfill();

    const rows = await readStarterGrants(orgId);
    expect(rows).toHaveLength(0);
  });

  it("skips Pro orgs — only the free starter pool expires", async () => {
    const orgId = uniqueId("org-backfill-pro");
    await seedOrg(orgId, "pro", 20_000);
    await clearStarterGrants(orgId);

    await runBackfill();

    const rows = await readStarterGrants(orgId);
    expect(rows).toHaveLength(0);
  });

  it("is idempotent — re-running does not create a second row", async () => {
    const orgId = uniqueId("org-backfill-idem");
    await seedOrg(orgId, "free", 30_000);
    await clearStarterGrants(orgId);

    await runBackfill();
    await runBackfill();

    const rows = await readStarterGrants(orgId);
    expect(rows).toHaveLength(1);
  });
});
