import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import {
  insertTestCreditPricing,
  insertTestCreditUsage,
  findTestCreditUsage,
  getOrgCredits,
  insertOrgCacheEntry,
  insertOrgMembersEntry,
  getOrgMembersEntry,
  updateOrgStripeFields,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request("http://localhost:3000/api/cron/process-credits", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("GET /api/cron/process-credits", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    reloadEnv();
    user = await context.setupUser();
  });

  describe("auth", () => {
    it("returns 401 with missing authorization header", async () => {
      const response = await GET(cronRequest());
      expect(response.status).toBe(401);
    });

    it("returns 401 with wrong cron secret", async () => {
      const response = await GET(cronRequest("wrong-secret"));
      expect(response.status).toBe(401);
    });
  });

  describe("credit processing", () => {
    it("no-ops when no pending records exist", async () => {
      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      const credits = await getOrgCredits(user.orgId);
      expect(credits).toBe(10_000);
    });

    it("processes a single pending record with correct calculation", async () => {
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 100,
        outputTokenPrice: 200,
      });

      const usageId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 1000,
        outputTokens: 500,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      // input: ceil(1000 * 100 / 1_000_000) = 1
      // output: ceil(500 * 200 / 1_000_000) = 1
      // total: 2
      const record = await findTestCreditUsage(usageId);
      expect(record!.status).toBe("processed");
      expect(record!.creditsCharged).toBe(2);
      expect(record!.processedAt).toBeInstanceOf(Date);

      const credits = await getOrgCredits(user.orgId);
      expect(credits).toBe(9998);
    });

    it("processes multiple pending records in a batch", async () => {
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 1_000_000,
        outputTokenPrice: 1_000_000,
      });

      const id1 = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 100,
      });
      const id2 = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 200,
        outputTokens: 200,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      const record1 = await findTestCreditUsage(id1);
      expect(record1!.status).toBe("processed");
      expect(record1!.creditsCharged).toBe(200);

      const record2 = await findTestCreditUsage(id2);
      expect(record2!.status).toBe("processed");
      expect(record2!.creditsCharged).toBe(400);

      const credits = await getOrgCredits(user.orgId);
      expect(credits).toBe(9400);
    });

    it("skips already-processed records", async () => {
      await insertTestCreditPricing("gpt-4");

      const usageId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        status: "processed",
        creditsCharged: 500,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      const record = await findTestCreditUsage(usageId);
      expect(record!.status).toBe("processed");
      expect(record!.creditsCharged).toBe(500);

      const credits = await getOrgCredits(user.orgId);
      expect(credits).toBe(10_000);
    });

    it("marks records with no matching pricing as processed with zero charge", async () => {
      const usageId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "unknown-model",
      });

      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      const record = await findTestCreditUsage(usageId);
      expect(record!.status).toBe("processed");
      expect(record!.creditsCharged).toBe(0);
      expect(record!.processedAt).toBeInstanceOf(Date);
    });

    it("includes cache tokens in credit calculation", async () => {
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 100,
        outputTokenPrice: 200,
        cacheReadTokenPrice: 10,
        cacheCreationTokenPrice: 150,
      });

      const usageId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 6000,
        cacheCreationInputTokens: 18000,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      // input: ceil(1000 * 100 / 1_000_000) = 1
      // output: ceil(500 * 200 / 1_000_000) = 1
      // cacheRead: ceil(6000 * 10 / 1_000_000) = 1
      // cacheCreation: ceil(18000 * 150 / 1_000_000) = 3
      // total: 6
      const record = await findTestCreditUsage(usageId);
      expect(record!.status).toBe("processed");
      expect(record!.creditsCharged).toBe(6);

      const credits = await getOrgCredits(user.orgId);
      expect(credits).toBe(9994);
    });

    it("charges only when model+provider matches pricing", async () => {
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 1_000_000,
        outputTokenPrice: 1_000_000,
        modelProvider: "anthropic-api-key",
      });

      const chargedId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        modelProvider: "anthropic-api-key",
        inputTokens: 100,
        outputTokens: 100,
      });

      const freeId = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        modelProvider: "user-own-key",
        inputTokens: 100,
        outputTokens: 100,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      const charged = await findTestCreditUsage(chargedId);
      expect(charged!.status).toBe("processed");
      expect(charged!.creditsCharged).toBe(200);

      const free = await findTestCreditUsage(freeId);
      expect(free!.status).toBe("processed");
      expect(free!.creditsCharged).toBe(0);

      const credits = await getOrgCredits(user.orgId);
      expect(credits).toBe(9800);
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
      });

      await Promise.all([
        GET(cronRequest("test-cron-secret")),
        GET(cronRequest("test-cron-secret")),
      ]);

      const record = await findTestCreditUsage(usageId);
      expect(record!.status).toBe("processed");
      expect(record!.creditsCharged).toBe(200);

      const credits = await getOrgCredits(user.orgId);
      expect(credits).toBe(9800);
    });

    it("finds and processes all orgs with pending records", async () => {
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 1_000_000,
        outputTokenPrice: 1_000_000,
      });

      const org2Id = uniqueId("org");
      await insertOrgCacheEntry({ orgId: org2Id, slug: uniqueId("slug") });

      const id1 = await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 0,
      });
      const id2 = await insertTestCreditUsage(org2Id, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 200,
        outputTokens: 0,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.processed).toBeGreaterThanOrEqual(2);

      const record1 = await findTestCreditUsage(id1);
      expect(record1!.status).toBe("processed");

      const record2 = await findTestCreditUsage(id2);
      expect(record2!.status).toBe("processed");
    });
  });

  describe("member cap evaluation", () => {
    it("disables member when usage exceeds cap after credit processing", async () => {
      const periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
      await updateOrgStripeFields(user.orgId, { currentPeriodEnd: periodEnd });

      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: true,
      });

      // Set up pricing so the usage will exceed the 100-credit cap
      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 1_000_000,
        outputTokenPrice: 1_000_000,
      });

      // 200 input + 200 output = 400 credits, exceeding the 100 cap
      await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 200,
        outputTokens: 200,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      const member = await getOrgMembersEntry(user.orgId, user.userId);
      expect(member?.creditEnabled).toBe(false);
    });

    it("skips already-disabled members", async () => {
      const periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
      await updateOrgStripeFields(user.orgId, { currentPeriodEnd: periodEnd });

      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      await insertTestCreditPricing("gpt-4", {
        inputTokenPrice: 1_000_000,
        outputTokenPrice: 1_000_000,
      });

      await insertTestCreditUsage(user.orgId, {
        userId: user.userId,
        model: "gpt-4",
        inputTokens: 200,
        outputTokens: 200,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      expect(response.status).toBe(200);

      const member = await getOrgMembersEntry(user.orgId, user.userId);
      expect(member?.creditEnabled).toBe(false);
    });
  });
});
