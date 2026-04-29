import { describe, it, expect, beforeEach } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  createTestRequest,
  deleteTestUsageEventsByProvider,
  insertTestUsageEvent,
  seedUserFeatureSwitches,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import type { ModelUsageRankingResponse } from "@vm0/api-contracts/contracts/zero-model-usage-ranking";

import { GET } from "../route";

const context = testContext();
let user: UserContext;

function makeRequest(range = "7d") {
  return createTestRequest(
    `http://localhost:3000/api/zero/model-usage-ranking?range=${range}`,
  );
}

describe("GET /api/zero/model-usage-ranking", () => {
  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
  });

  it("returns 403 when model usage ranking is disabled", async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
  });

  it("returns platform-wide model token ranking without org or user details", async () => {
    await seedUserFeatureSwitches(user.orgId, user.userId, {
      [FeatureSwitchKey.ModelUsageRanking]: true,
    });

    const now = new Date();
    const old = new Date(now.getTime() - 31 * 86_400_000);
    const modelA = `test-model-a-${Date.now()}`;
    const modelB = `test-model-b-${Date.now()}`;
    const pendingModel = `test-model-pending-${Date.now()}`;
    const oldModel = `test-model-old-${Date.now()}`;
    const sonnetAlias = "anthropic/claude-sonnet-4.6";
    const sonnetModel = "claude-sonnet-4-6";
    const insertedModels = [
      modelA,
      modelB,
      pendingModel,
      oldModel,
      sonnetAlias,
    ];

    try {
      await insertTestUsageEvent("org-a", {
        userId: "user-a",
        kind: "model",
        provider: modelA,
        category: "tokens.input",
        quantity: 20_000_000,
        status: "processed",
        creditsCharged: 10_000_000,
        createdAt: now,
      });
      await insertTestUsageEvent("org-b", {
        userId: "user-b",
        kind: "model",
        provider: modelA,
        category: "tokens.output",
        quantity: 10_000_000,
        status: "processed",
        creditsCharged: 20_000_000,
        createdAt: now,
      });
      await insertTestUsageEvent("org-c", {
        userId: "user-c",
        kind: "model",
        provider: modelB,
        category: "tokens.input",
        quantity: 15_000_000,
        status: "processed",
        creditsCharged: 50_000_000,
        createdAt: now,
      });
      await insertTestUsageEvent("org-sonnet", {
        userId: "user-sonnet",
        kind: "model",
        provider: sonnetAlias,
        category: "tokens.input",
        quantity: 90_000_000,
        status: "processed",
        creditsCharged: 1,
        createdAt: now,
      });
      await insertTestUsageEvent("org-d", {
        userId: "user-d",
        kind: "model",
        provider: pendingModel,
        category: "tokens.input",
        quantity: 100_000_000,
        status: "pending",
        createdAt: now,
      });
      await insertTestUsageEvent("org-e", {
        userId: "user-e",
        kind: "model",
        provider: oldModel,
        category: "tokens.input",
        quantity: 100_000_000,
        status: "processed",
        createdAt: old,
        processedAt: old,
      });

      const response = await GET(makeRequest("30d"));

      expect(response.status).toBe(200);
      const data = (await response.json()) as ModelUsageRankingResponse;
      const modelARow = data.models.find((row) => {
        return row.model === modelA;
      });
      const modelBRow = data.models.find((row) => {
        return row.model === modelB;
      });
      const sonnetRow = data.models.find((row) => {
        return row.model === sonnetModel;
      });
      const modelAIndex = data.models.findIndex((row) => {
        return row.model === modelA;
      });
      const modelBIndex = data.models.findIndex((row) => {
        return row.model === modelB;
      });
      expect(data.range).toBe("30d");
      expect(data.grandTotalTokens).toBeGreaterThanOrEqual(135_000_000);
      expect(modelBIndex).toBeGreaterThanOrEqual(0);
      expect(modelAIndex).toBeGreaterThanOrEqual(0);
      expect(modelAIndex).toBeLessThan(modelBIndex);
      expect(modelARow).toMatchObject({
        model: modelA,
        inputTokens: 20_000_000,
        outputTokens: 10_000_000,
        cacheTokens: 0,
        totalTokens: 30_000_000,
        previousTotalTokens: 0,
        changePercent: null,
      });
      expect(modelBRow).toMatchObject({
        model: modelB,
        inputTokens: 15_000_000,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens: 15_000_000,
        previousTotalTokens: 0,
        changePercent: null,
      });
      expect(sonnetRow).toMatchObject({
        model: sonnetModel,
        inputTokens: expect.any(Number),
        totalTokens: expect.any(Number),
      });
      expect(sonnetRow?.inputTokens).toBeGreaterThanOrEqual(90_000_000);
      expect(data.daily).toHaveLength(30);
      const today = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      )
        .toISOString()
        .slice(0, 10);
      const todayBucket = data.daily.find((bucket) => {
        return bucket.date === today;
      });
      expect(todayBucket?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: modelA,
            totalTokens: 30_000_000,
          }),
          expect.objectContaining({
            model: modelB,
            totalTokens: 15_000_000,
          }),
        ]),
      );
      expect(
        data.models.some((row) => {
          return row.model === pendingModel;
        }),
      ).toBe(false);
      expect(
        data.models.some((row) => {
          return row.model === oldModel;
        }),
      ).toBe(false);
      expect(
        data.models.some((row) => {
          return row.model === sonnetAlias;
        }),
      ).toBe(false);
      expect(JSON.stringify(data)).not.toContain("org-a");
      expect(JSON.stringify(data)).not.toContain("user-a");
      expect(JSON.stringify(data)).not.toContain("credits");
      expect(JSON.stringify(data)).not.toContain("request");
    } finally {
      await deleteTestUsageEventsByProvider(insertedModels);
    }
  });
});
