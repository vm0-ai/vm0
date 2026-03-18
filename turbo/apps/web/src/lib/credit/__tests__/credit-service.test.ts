import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  insertOrgCacheEntry,
  insertTestCreditPricing,
  insertTestCreditUsage,
  findTestCreditUsage,
  getOrgCacheEntry,
} from "../../../__tests__/api-test-helpers";
import { processOrgCredits, processStaleCredits } from "../credit-service";

const context = testContext();

type ClerkOrg = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof clerkClient>>["organizations"]["getOrganization"]
  >
>;

describe("credit-service", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("processOrgCredits", () => {
    it("no-ops when no pending records exist", async () => {
      await processOrgCredits(user.orgId);

      // Verify no Clerk calls were made
      const client = await clerkClient();
      expect(client.organizations.getOrganization).not.toHaveBeenCalled();
    });

    it("processes a single pending record with correct calculation", async () => {
      // Set up pricing: input=100/M, output=200/M
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 100,
        outputTokenPrice: 200,
      });

      // Insert usage: 1000 input, 500 output
      const usageId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 1000,
        outputTokens: 500,
        numEvents: 2,
      });

      // Mock Clerk to return current balance
      const client = await clerkClient();
      vi.mocked(client.organizations.getOrganization).mockResolvedValueOnce({
        id: user.orgId,
        privateMetadata: { credits: 10000 },
      } as unknown as ClerkOrg);

      await processOrgCredits(user.orgId);

      // Verify calculation (purely token-based):
      // input: ceil(1000 * 100 / 1_000_000) = ceil(0.1) = 1
      // output: ceil(500 * 200 / 1_000_000) = ceil(0.1) = 1
      // total: 1 + 1 = 2
      const record = await findTestCreditUsage(usageId);
      expect(record!.status).toBe("processed");
      expect(record!.creditsCharged).toBe(2);
      expect(record!.processedAt).toBeInstanceOf(Date);

      // Verify Clerk was called with correct balance deduction
      expect(
        client.organizations.updateOrganizationMetadata,
      ).toHaveBeenCalledWith(user.orgId, {
        privateMetadata: { credits: 10000 - 2 },
      });

      // Verify org cache was invalidated
      const cacheEntry = await getOrgCacheEntry(user.orgId);
      expect(cacheEntry).toBeNull();
    });

    it("processes multiple pending records in a batch", async () => {
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 1_000_000,
        outputTokenPrice: 1_000_000,
      });

      // Insert two usage records
      const id1 = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 100,
        numEvents: 1,
      });
      const id2 = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 200,
        outputTokens: 200,
        numEvents: 2,
      });

      const client = await clerkClient();
      vi.mocked(client.organizations.getOrganization).mockResolvedValueOnce({
        id: user.orgId,
        privateMetadata: { credits: 50000 },
      } as unknown as ClerkOrg);

      await processOrgCredits(user.orgId);

      // Record 1: ceil(100*1M/1M) + ceil(100*1M/1M) = 100 + 100 = 200
      const record1 = await findTestCreditUsage(id1);
      expect(record1!.status).toBe("processed");
      expect(record1!.creditsCharged).toBe(200);

      // Record 2: ceil(200*1M/1M) + ceil(200*1M/1M) = 200 + 200 = 400
      const record2 = await findTestCreditUsage(id2);
      expect(record2!.status).toBe("processed");
      expect(record2!.creditsCharged).toBe(400);

      // Total: 200 + 400 = 600
      expect(
        client.organizations.updateOrganizationMetadata,
      ).toHaveBeenCalledWith(user.orgId, {
        privateMetadata: { credits: 50000 - 600 },
      });
    });

    it("skips already-processed records", async () => {
      await insertTestCreditPricing("gpt-4");

      // Insert a processed record
      const usageId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        status: "processed",
        creditsCharged: 500,
      });

      await processOrgCredits(user.orgId);

      // Record should be unchanged
      const record = await findTestCreditUsage(usageId);
      expect(record!.status).toBe("processed");
      expect(record!.creditsCharged).toBe(500);

      // No Clerk calls since nothing to process
      const client = await clerkClient();
      expect(client.organizations.getOrganization).not.toHaveBeenCalled();
    });

    it("skips records with missing pricing and leaves them as pending", async () => {
      // No pricing for "unknown-model"
      const usageId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "unknown-model",
      });

      await processOrgCredits(user.orgId);

      // Record should still be pending
      const record = await findTestCreditUsage(usageId);
      expect(record!.status).toBe("pending");
      expect(record!.creditsCharged).toBeNull();

      // No Clerk calls since nothing was actually processed
      const client = await clerkClient();
      expect(client.organizations.getOrganization).not.toHaveBeenCalled();
    });

    it("concurrent calls serialize via advisory lock (no double-processing)", async () => {
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 1_000_000,
        outputTokenPrice: 1_000_000,
      });

      const usageId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 100,
        numEvents: 0,
      });

      const client = await clerkClient();
      vi.mocked(client.organizations.getOrganization).mockResolvedValue({
        id: user.orgId,
        privateMetadata: { credits: 10000 },
      } as unknown as ClerkOrg);

      // Run two concurrent calls
      await Promise.all([
        processOrgCredits(user.orgId),
        processOrgCredits(user.orgId),
      ]);

      // Record should be processed exactly once
      const record = await findTestCreditUsage(usageId);
      expect(record!.status).toBe("processed");
      expect(record!.creditsCharged).toBe(200);

      // Clerk should have been called exactly once (second call is a no-op)
      expect(
        client.organizations.updateOrganizationMetadata,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("processStaleCredits", () => {
    it("finds and processes all orgs with pending records", async () => {
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 1_000_000,
        outputTokenPrice: 1_000_000,
      });

      // Create a second org
      const org2Id = uniqueId("org");
      await insertOrgCacheEntry({ orgId: org2Id, slug: uniqueId("slug") });

      // Insert records for both orgs
      const id1 = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 0,
        numEvents: 0,
      });
      const id2 = await insertTestCreditUsage(org2Id, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 200,
        outputTokens: 0,
        numEvents: 0,
      });

      const client = await clerkClient();
      vi.mocked(client.organizations.getOrganization).mockResolvedValue({
        id: "any",
        privateMetadata: { credits: 99999 },
      } as unknown as ClerkOrg);

      const count = await processStaleCredits();

      // At least 2 orgs processed (may include leftover records from other tests)
      expect(count).toBeGreaterThanOrEqual(2);

      const record1 = await findTestCreditUsage(id1);
      expect(record1!.status).toBe("processed");

      const record2 = await findTestCreditUsage(id2);
      expect(record2!.status).toBe("processed");
    });
  });
});
