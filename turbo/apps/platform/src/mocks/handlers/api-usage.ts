import {
  zeroUsageMembersContract,
  type UsageMembersResponse,
} from "@vm0/api-contracts/contracts/zero-usage";
import {
  zeroModelUsageRankingContract,
  type ModelUsageRankingItem,
  type ModelUsageRankingRange,
} from "@vm0/api-contracts/contracts/zero-model-usage-ranking";
import { zeroMemberCreditCapContract } from "@vm0/api-contracts/contracts/zero-member-credit-cap";
import { mockApi } from "../msw-contract.ts";

let mockUsageMembersResponse: UsageMembersResponse = {
  period: null,
  members: [],
};

const defaultModelUsageRankingModels: ModelUsageRankingItem[] = [
  {
    model: "claude-sonnet-4-6",
    inputTokens: 850_000,
    outputTokens: 310_000,
    cacheTokens: 120_000,
    totalTokens: 1_280_000,
    credits: 12_400,
    previousCredits: 9000,
    changePercent: 0.3778,
    share: 0.6,
  },
  {
    model: "kimi-k2.6",
    inputTokens: 420_000,
    outputTokens: 180_000,
    cacheTokens: 60_000,
    totalTokens: 660_000,
    credits: 4900,
    previousCredits: 3600,
    changePercent: 0.3611,
    share: 0.24,
  },
  {
    model: "deepseek-v4-pro",
    inputTokens: 240_000,
    outputTokens: 170_000,
    cacheTokens: 30_000,
    totalTokens: 440_000,
    credits: 3200,
    previousCredits: 0,
    changePercent: null,
    share: 0.16,
  },
];

let mockModelUsageRankingModels = defaultModelUsageRankingModels;

const mockCreditCaps = new Map<
  string,
  { creditCap: number | null; creditEnabled: boolean }
>();

export function setMockUsageMembers(
  overrides: Partial<UsageMembersResponse>,
): void {
  mockUsageMembersResponse = { ...mockUsageMembersResponse, ...overrides };
}

export function resetMockUsageMembers(): void {
  mockUsageMembersResponse = { period: null, members: [] };
}

export function setMockModelUsageRanking(
  models: ModelUsageRankingItem[],
): void {
  mockModelUsageRankingModels = models;
}

export function resetMockModelUsageRanking(): void {
  mockModelUsageRankingModels = defaultModelUsageRankingModels;
}

export function setMockMemberCreditCap(
  userId: string,
  creditCap: number | null,
  creditEnabled: boolean,
): void {
  mockCreditCaps.set(userId, { creditCap, creditEnabled });
}

export function resetMockMemberCreditCaps(): void {
  mockCreditCaps.clear();
}

function makeMockModelUsageDaily(
  models: ModelUsageRankingItem[],
  range: ModelUsageRankingRange,
) {
  const dayCount = range === "1d" ? 1 : range === "7d" ? 7 : 30;
  const today = new Date("2026-04-29T00:00:00.000Z");
  return Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(today.getTime() - (dayCount - 1 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const progress = dayCount === 1 ? 1 : (index + 1) / dayCount;
    const dailyModels = models.map((item, modelIndex) => {
      const weight = 0.5 + progress * (0.7 + modelIndex * 0.12);
      return {
        model: item.model,
        credits: Math.round((item.credits / dayCount) * weight),
        totalTokens: Math.round((item.totalTokens / dayCount) * weight),
      };
    });
    return {
      date,
      totalCredits: dailyModels.reduce((sum, item) => {
        return sum + item.credits;
      }, 0),
      totalTokens: dailyModels.reduce((sum, item) => {
        return sum + item.totalTokens;
      }, 0),
      models: dailyModels,
    };
  });
}

export const apiUsageHandlers = [
  mockApi(zeroUsageMembersContract.get, ({ respond }) => {
    return respond(200, mockUsageMembersResponse);
  }),

  mockApi(zeroModelUsageRankingContract.get, ({ query, respond }) => {
    const grandTotalTokens = mockModelUsageRankingModels.reduce((sum, item) => {
      return sum + item.totalTokens;
    }, 0);
    const grandTotalCredits = mockModelUsageRankingModels.reduce(
      (sum, item) => {
        return sum + item.credits;
      },
      0,
    );
    return respond(200, {
      range: query.range as ModelUsageRankingRange,
      generatedAt: "2026-04-29T00:00:00.000Z",
      grandTotalTokens,
      grandTotalCredits,
      models: mockModelUsageRankingModels,
      daily: makeMockModelUsageDaily(
        mockModelUsageRankingModels,
        query.range as ModelUsageRankingRange,
      ),
    });
  }),

  mockApi(zeroMemberCreditCapContract.get, ({ query, respond }) => {
    const entry = mockCreditCaps.get(query.userId);
    if (!entry) {
      return respond(200, {
        userId: query.userId,
        creditCap: null,
        creditEnabled: true,
      });
    }
    return respond(200, {
      userId: query.userId,
      creditCap: entry.creditCap,
      creditEnabled: entry.creditEnabled,
    });
  }),

  mockApi(zeroMemberCreditCapContract.set, ({ body, respond }) => {
    const existing = mockCreditCaps.get(body.userId);
    mockCreditCaps.set(body.userId, {
      creditCap: body.creditCap,
      creditEnabled: existing?.creditEnabled ?? true,
    });
    return respond(200, {
      userId: body.userId,
      creditCap: body.creditCap,
      creditEnabled: existing?.creditEnabled ?? true,
    });
  }),
];
