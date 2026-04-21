import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  findCreditExpiresRecords,
  getOrgCredits,
  insertCreditExpiresRecord,
} from "../../../../__tests__/api-test-helpers";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: ensureStarterCreditGrant is the seam under test
import {
  ensureStarterCreditGrant,
  STARTER_GRANT_AMOUNT,
  STARTER_GRANT_SOURCE,
} from "../starter-grant-service";

const context = testContext();

async function callEnsureStarterCreditGrant(orgId: string): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: helper accepts a tx
  await globalThis.services.db.transaction(async (tx) => {
    await ensureStarterCreditGrant(tx, orgId);
  });
}

describe("ensureStarterCreditGrant", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("first call grants 10k credits and writes one starter_grant expires row", async () => {
    const { orgId } = await context.setupUser();

    await callEnsureStarterCreditGrant(orgId);

    expect(await getOrgCredits(orgId)).toBe(STARTER_GRANT_AMOUNT);

    const rows = await findCreditExpiresRecords(orgId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBe(STARTER_GRANT_SOURCE);
    expect(row.stripeInvoiceId).toBeNull();
    expect(row.amount).toBe(STARTER_GRANT_AMOUNT);
    expect(row.remaining).toBe(STARTER_GRANT_AMOUNT);

    const approxOneMonth = new Date();
    approxOneMonth.setMonth(approxOneMonth.getMonth() + 1);
    const diffMs = Math.abs(row.expiresAt.getTime() - approxOneMonth.getTime());
    // Tolerate a minute of clock drift between helper call and assertion.
    expect(diffMs).toBeLessThan(60_000);
  });

  it("second call is a no-op — no double grant, still one row", async () => {
    const { orgId } = await context.setupUser();

    await callEnsureStarterCreditGrant(orgId);
    await callEnsureStarterCreditGrant(orgId);

    expect(await getOrgCredits(orgId)).toBe(STARTER_GRANT_AMOUNT);
    const rows = await findCreditExpiresRecords(orgId);
    expect(rows).toHaveLength(1);
  });

  it("coexists with a subscription_renewal expires row", async () => {
    const { orgId } = await context.setupUser();

    const futureDate = new Date();
    futureDate.setMonth(futureDate.getMonth() + 2);
    await insertCreditExpiresRecord({
      orgId,
      source: "subscription_renewal",
      stripeInvoiceId: uniqueId("inv-coexist"),
      amount: 20_000,
      remaining: 20_000,
      expiresAt: futureDate,
    });

    await callEnsureStarterCreditGrant(orgId);

    const rows = await findCreditExpiresRecords(orgId);
    expect(rows).toHaveLength(2);
    const sources = rows
      .map((r) => {
        return r.source;
      })
      .sort();
    expect(sources).toEqual(["starter_grant", "subscription_renewal"]);
  });
});
