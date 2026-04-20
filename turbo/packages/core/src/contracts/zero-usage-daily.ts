import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// --- Daily Credits Contract ---

const dailyCreditSchema = z.object({
  date: z.string(),
  creditsCharged: z.number(),
});

const dailyCreditByMemberSchema = z.object({
  date: z.string(),
  members: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      creditsCharged: z.number(),
    }),
  ),
});

const usageDailyResponseSchema = z.object({
  period: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .nullable(),
  daily: z.array(dailyCreditSchema),
  dailyByMember: z.array(dailyCreditByMemberSchema),
});

export const zeroUsageDailyContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/usage/daily",
    headers: authHeadersSchema,
    query: z.object({
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      mode: z.enum(["total", "member"]).default("total"),
    }),
    responses: {
      200: usageDailyResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get daily credit usage for the org",
  },
});

// --- Per-Run Records Contract ---

const usageRunSchema = z.object({
  runId: z.string(),
  agentName: z.string().nullable(),
  memberEmail: z.string(),
  userId: z.string(),
  triggerSource: z.string().nullable(),
  model: z.string(),
  status: z.string(),
  prompt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheTokens: z.number(),
  creditsCharged: z.number(),
  createdAt: z.string(),
});

const usageRunsResponseSchema = z.object({
  runs: z.array(usageRunSchema),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
  }),
});

export const zeroUsageRunsContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/usage/runs",
    headers: authHeadersSchema,
    query: z.object({
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().positive().max(100).default(20),
      agentId: z.string().optional(),
      // Comma-separated list of user IDs to filter by. Empty string = no filter.
      userIds: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    }),
    responses: {
      200: usageRunsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get per-run credit usage records for the org",
  },
});

export type ZeroUsageDailyContract = typeof zeroUsageDailyContract;
export type ZeroUsageRunsContract = typeof zeroUsageRunsContract;

export type UsageDailyResponse = z.infer<typeof usageDailyResponseSchema>;
export type DailyCredit = z.infer<typeof dailyCreditSchema>;
export type DailyCreditByMember = z.infer<typeof dailyCreditByMemberSchema>;
export type UsageRun = z.infer<typeof usageRunSchema>;
export type UsageRunsResponse = z.infer<typeof usageRunsResponseSchema>;
