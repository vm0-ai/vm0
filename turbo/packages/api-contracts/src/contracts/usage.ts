import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const dailyUsageSchema = z.object({
  date: z.string(),
  run_count: z.number(),
  run_time_ms: z.number(),
});

const usageResponseSchema = z.object({
  period: z.object({
    start: z.string(),
    end: z.string(),
  }),
  summary: z.object({
    total_runs: z.number(),
    total_run_time_ms: z.number(),
  }),
  daily: z.array(dailyUsageSchema),
});

export const usageContract = c.router({
  get: {
    method: "GET",
    path: "/api/usage",
    headers: authHeadersSchema,
    query: z.object({
      start_date: z.string().optional(),
      end_date: z.string().optional(),
    }),
    responses: {
      200: usageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get personal daily run usage for the signed-in user",
  },
});

export type UsageContract = typeof usageContract;
export type DailyUsage = z.infer<typeof dailyUsageSchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
