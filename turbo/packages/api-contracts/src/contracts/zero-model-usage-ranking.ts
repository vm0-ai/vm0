import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const modelUsageRankingRangeSchema = z.enum(["1d", "7d", "30d"]);

const modelUsageRankingItemSchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheTokens: z.number(),
  totalTokens: z.number(),
  credits: z.number(),
  previousCredits: z.number(),
  changePercent: z.number().nullable(),
  share: z.number(),
});

const modelUsageRankingDailyModelSchema = z.object({
  model: z.string(),
  credits: z.number(),
  totalTokens: z.number(),
});

const modelUsageRankingDailyBucketSchema = z.object({
  date: z.string(),
  totalCredits: z.number(),
  totalTokens: z.number(),
  models: z.array(modelUsageRankingDailyModelSchema),
});

const modelUsageRankingResponseSchema = z.object({
  range: modelUsageRankingRangeSchema,
  generatedAt: z.string(),
  grandTotalTokens: z.number(),
  grandTotalCredits: z.number(),
  models: z.array(modelUsageRankingItemSchema),
  daily: z.array(modelUsageRankingDailyBucketSchema),
});

export const zeroModelUsageRankingContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/model-usage-ranking",
    headers: authHeadersSchema,
    query: z.object({
      range: modelUsageRankingRangeSchema,
    }),
    responses: {
      200: modelUsageRankingResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get anonymous VM0 model popularity ranking",
  },
});

export type ModelUsageRankingRange = z.infer<
  typeof modelUsageRankingRangeSchema
>;
export type ModelUsageRankingItem = z.infer<typeof modelUsageRankingItemSchema>;
export type ModelUsageRankingDailyBucket = z.infer<
  typeof modelUsageRankingDailyBucketSchema
>;
export type ModelUsageRankingResponse = z.infer<
  typeof modelUsageRankingResponseSchema
>;
export type ZeroModelUsageRankingContract =
  typeof zeroModelUsageRankingContract;
