import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  insertCreditExpiresRecord,
  findCreditExpiresRecords,
  getOrgCredits,
  grantCreditsToOrg,
  testDeductFromExpiresRecords,
  testExpireCredits,
} from "../../../../__tests__/api-test-helpers";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import {
  getExpiresRecordsSummary,
  getUnsettledExpiredAmount,
} from "../credit-expires-service";

const context = testContext();

describe("credit expires service", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("deductFromExpiresRecords (FEFO)", () => {
    it("single record covers all deduction", async () => {
      const { orgId } = await context.setupUser({ prefix: "fefo-single" });

      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 2);
      await insertCreditExpiresRecord({
        orgId,
        amount: 10000,
        expiresAt: futureDate,
        stripeInvoiceId: uniqueId("inv"),
      });

      await testDeductFromExpiresRecords(orgId, 3000);

      const records = await findCreditExpiresRecords(orgId);
      expect(records).toHaveLength(1);
      expect(records[0]!.remaining).toBe(7000);
    });

    it("deduction spans multiple records (FEFO order)", async () => {
      const { orgId } = await context.setupUser({ prefix: "fefo-multi" });

      const earlyDate = new Date();
      earlyDate.setMonth(earlyDate.getMonth() + 1);
      const lateDate = new Date();
      lateDate.setMonth(lateDate.getMonth() + 3);

      await insertCreditExpiresRecord({
        orgId,
        amount: 5000,
        expiresAt: earlyDate,
        stripeInvoiceId: uniqueId("inv-early"),
      });
      await insertCreditExpiresRecord({
        orgId,
        amount: 8000,
        expiresAt: lateDate,
        stripeInvoiceId: uniqueId("inv-late"),
      });

      await testDeductFromExpiresRecords(orgId, 7000);

      const records = await findCreditExpiresRecords(orgId);
      // Early record fully consumed, late record partially consumed
      expect(records[0]!.remaining).toBe(0);
      expect(records[1]!.remaining).toBe(6000);
    });

    it("insufficient expiring credits — excess from non-expiring pool", async () => {
      const { orgId } = await context.setupUser({ prefix: "fefo-excess" });

      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 2);
      await insertCreditExpiresRecord({
        orgId,
        amount: 3000,
        expiresAt: futureDate,
        stripeInvoiceId: uniqueId("inv"),
      });

      await testDeductFromExpiresRecords(orgId, 5000);

      const records = await findCreditExpiresRecords(orgId);
      // All expiring credits consumed, no error
      expect(records[0]!.remaining).toBe(0);
    });

    it("no expires records — no error", async () => {
      const { orgId } = await context.setupUser({ prefix: "fefo-none" });

      await testDeductFromExpiresRecords(orgId, 1000);

      const records = await findCreditExpiresRecords(orgId);
      expect(records).toHaveLength(0);
    });

    it("skips expired rows — drains the unexpired row instead", async () => {
      const { orgId } = await context.setupUser({
        prefix: "fefo-skip-expired",
      });

      const pastDate = new Date();
      pastDate.setMonth(pastDate.getMonth() - 1);
      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 2);

      const expiredId = await insertCreditExpiresRecord({
        orgId,
        amount: 5000,
        expiresAt: pastDate,
        stripeInvoiceId: uniqueId("inv-expired"),
      });
      const activeId = await insertCreditExpiresRecord({
        orgId,
        amount: 5000,
        expiresAt: futureDate,
        stripeInvoiceId: uniqueId("inv-active"),
      });

      await testDeductFromExpiresRecords(orgId, 3000);

      const records = await findCreditExpiresRecords(orgId);
      const expired = records.find((r) => {
        return r.id === expiredId;
      })!;
      const active = records.find((r) => {
        return r.id === activeId;
      })!;
      // Expired row untouched, active row debited
      expect(expired.remaining).toBe(5000);
      expect(active.remaining).toBe(2000);
    });
  });

  describe("expireCredits", () => {
    it("settles expired records and deducts from org balance", async () => {
      const { orgId } = await context.setupUser({ prefix: "expire-settle" });

      // Grant some credits so there is a balance
      await grantCreditsToOrg(orgId, 20000);

      const pastDate = new Date();
      pastDate.setMonth(pastDate.getMonth() - 1);
      await insertCreditExpiresRecord({
        orgId,
        amount: 5000,
        remaining: 3000,
        expiresAt: pastDate,
        stripeInvoiceId: uniqueId("inv-expired"),
      });

      const creditsBefore = await getOrgCredits(orgId);

      const totalExpired = await testExpireCredits(orgId);

      expect(totalExpired).toBe(3000);

      const creditsAfter = await getOrgCredits(orgId);
      expect(creditsAfter).toBe(creditsBefore! - 3000);

      const records = await findCreditExpiresRecords(orgId);
      expect(records[0]!.remaining).toBe(0);
    });

    it("does nothing when no records are expired", async () => {
      const { orgId } = await context.setupUser({ prefix: "expire-none" });

      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 2);
      await insertCreditExpiresRecord({
        orgId,
        amount: 5000,
        expiresAt: futureDate,
        stripeInvoiceId: uniqueId("inv-future"),
      });

      const totalExpired = await testExpireCredits(orgId);

      expect(totalExpired).toBe(0);

      const records = await findCreditExpiresRecords(orgId);
      expect(records[0]!.remaining).toBe(5000);
    });
  });

  describe("getExpiresRecordsSummary", () => {
    it("returns summary for active records", async () => {
      const { orgId } = await context.setupUser({ prefix: "summary" });

      const expiryDate = new Date("2026-05-01T00:00:00Z");
      await insertCreditExpiresRecord({
        orgId,
        amount: 10000,
        remaining: 7000,
        expiresAt: expiryDate,
        stripeInvoiceId: uniqueId("inv-summary"),
      });

      const summary = await getExpiresRecordsSummary(orgId);
      expect(summary.expiringNextCycle).toBe(7000);
      expect(summary.nextExpiryDate).toEqual(expiryDate);
    });

    it("returns zero for free org with no records", async () => {
      const { orgId } = await context.setupUser({ prefix: "summary-free" });

      const summary = await getExpiresRecordsSummary(orgId);
      expect(summary.expiringNextCycle).toBe(0);
      expect(summary.nextExpiryDate).toBeNull();
    });
  });

  describe("getUnsettledExpiredAmount", () => {
    it("returns zero when there are no expired rows", async () => {
      const { orgId } = await context.setupUser({ prefix: "unsettled-none" });

      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 2);
      await insertCreditExpiresRecord({
        orgId,
        amount: 5000,
        expiresAt: futureDate,
        stripeInvoiceId: uniqueId("inv-active"),
      });

      const amount = await getUnsettledExpiredAmount(orgId);
      expect(amount).toBe(0);
    });

    it("sums remaining across expired rows only", async () => {
      const { orgId } = await context.setupUser({ prefix: "unsettled-sum" });

      const pastDate = new Date();
      pastDate.setMonth(pastDate.getMonth() - 1);
      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 2);

      await insertCreditExpiresRecord({
        orgId,
        amount: 5000,
        remaining: 3000,
        expiresAt: pastDate,
        stripeInvoiceId: uniqueId("inv-expired-a"),
      });
      await insertCreditExpiresRecord({
        orgId,
        amount: 2000,
        remaining: 2000,
        expiresAt: pastDate,
        stripeInvoiceId: uniqueId("inv-expired-b"),
      });
      await insertCreditExpiresRecord({
        orgId,
        amount: 10000,
        remaining: 10000,
        expiresAt: futureDate,
        stripeInvoiceId: uniqueId("inv-active"),
      });

      const amount = await getUnsettledExpiredAmount(orgId);
      expect(amount).toBe(5000);
    });

    it("ignores expired rows that have already been settled to zero", async () => {
      const { orgId } = await context.setupUser({
        prefix: "unsettled-settled",
      });

      const pastDate = new Date();
      pastDate.setMonth(pastDate.getMonth() - 1);
      await insertCreditExpiresRecord({
        orgId,
        amount: 5000,
        remaining: 0,
        expiresAt: pastDate,
        stripeInvoiceId: uniqueId("inv-zeroed"),
      });

      const amount = await getUnsettledExpiredAmount(orgId);
      expect(amount).toBe(0);
    });
  });
});
