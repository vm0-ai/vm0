import { initContract } from "@ts-rest/core";
import { command } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import { authorization$ } from "../context/hono";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  aggregateModelStats$,
  DEFAULT_MODEL_STATS_REPROCESS_HOURS,
  MAX_MODEL_STATS_REPROCESS_HOURS,
} from "../services/model-stats.service";

const c = initContract();

const aggregateModelStatsContract = c.router({
  aggregate: {
    method: "GET" as const,
    path: "/api/internal/cron/aggregate-model-stats",
    headers: z.object({
      authorization: z.string().optional(),
    }),
    query: z.object({
      hours: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_MODEL_STATS_REPROCESS_HOURS)
        .optional(),
    }),
    responses: {
      200: z.object({
        success: z.literal(true),
        windowStart: z.string(),
        windowEnd: z.string(),
        aggregated: z.number(),
      }),
      401: z.object({
        error: z.object({
          message: z.string(),
          code: z.literal("UNAUTHORIZED"),
        }),
      }),
    },
    summary: "Aggregate hourly model usage statistics",
  },
});

const aggregateQuery$ = queryOf(aggregateModelStatsContract.aggregate);

function unauthorized() {
  return {
    status: 401 as const,
    body: {
      error: {
        message: "Invalid cron secret",
        code: "UNAUTHORIZED" as const,
      },
    },
  };
}

const aggregateModelStatsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const cronSecret = env("CRON_SECRET");
    if (!cronSecret || get(authorization$) !== `Bearer ${cronSecret}`) {
      return unauthorized();
    }

    const query = get(aggregateQuery$);
    const result = await set(
      aggregateModelStats$,
      query.hours ?? DEFAULT_MODEL_STATS_REPROCESS_HOURS,
      signal,
    );
    return {
      status: 200 as const,
      body: {
        success: true as const,
        windowStart: result.windowStart.toISOString(),
        windowEnd: result.windowEnd.toISOString(),
        aggregated: result.aggregated,
      },
    };
  },
);

export const modelStatsRoutes: readonly RouteEntry[] = [
  {
    route: aggregateModelStatsContract.aggregate,
    handler: aggregateModelStatsRoute$,
  },
];

export const modelStatsContract = aggregateModelStatsContract;
