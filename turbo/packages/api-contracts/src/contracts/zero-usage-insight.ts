import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const usageInsightBucketSchema = z.object({
  ts: z.string(), // ISO string for the bucket start
  series: z.record(z.string(), z.number()), // { chat: 123, slack: 45, ... }
  tokens: z.record(z.string(), z.number()), // same keys, total token counts
});

const usageInsightAutomationRowSchema = z.object({
  automationId: z.string(),
  automationName: z.string(),
  automationDescription: z.string().nullable(),
  credits: z.number(),
  tokens: z.number(),
});

const usageInsightChatRowSchema = z.object({
  threadId: z.string(),
  threadTitle: z.string().nullable(),
  credits: z.number(),
  tokens: z.number(),
});

const usageInsightResponseSchema = z.object({
  buckets: z.array(usageInsightBucketSchema),
  automations: z.array(usageInsightAutomationRowSchema),
  automationOtherCount: z.number(),
  automationOtherCredits: z.number(),
  chats: z.array(usageInsightChatRowSchema),
  chatOtherCount: z.number(),
  chatOtherCredits: z.number(),
  emailCredits: z.number(),
  emailTokens: z.number(),
  slackCredits: z.number(),
  slackTokens: z.number(),
  grandTotalCredits: z.number(),
  grandTotalTokens: z.number(),
});

export const zeroUsageInsightContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/usage/insight",
    headers: authHeadersSchema,
    query: z.object({
      range: z.enum(["today", "yesterday", "day", "7d", "28d", "30d"]),
      date: z.string().optional(),
      groupBy: z.enum(["source", "agent"]),
      tz: z.string(),
    }),
    responses: {
      200: usageInsightResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get personal usage insight for the signed-in user",
  },
});

export type ZeroUsageInsightContract = typeof zeroUsageInsightContract;
export type UsageInsightResponse = z.infer<typeof usageInsightResponseSchema>;
export type UsageInsightBucket = z.infer<typeof usageInsightBucketSchema>;
export type UsageInsightAutomationRow = z.infer<
  typeof usageInsightAutomationRowSchema
>;
export type UsageInsightChatRow = z.infer<typeof usageInsightChatRowSchema>;
