import { initContract } from "@ts-rest/core";
import { command } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import { authorization$, setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  aggregateModelStats$,
  DEFAULT_MODEL_STATS_REPROCESS_HOURS,
  MAX_MODEL_STATS_REPROCESS_HOURS,
  MODEL_RANKING_PERIODS,
  readPublicModelRankings$,
} from "../services/model-stats.service";

const c = initContract();
const PUBLIC_MODEL_RANKINGS_CACHE_CONTROL =
  "public, s-maxage=300, stale-while-revalidate=600";

const modelRankingRowSchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  previousTotalTokens: z.number(),
});

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
  rankings: {
    method: "GET" as const,
    path: "/api/public/model-rankings",
    query: z.object({
      period: z.string().optional(),
    }),
    responses: {
      200: z.object({
        period: z.enum(MODEL_RANKING_PERIODS),
        totalTokens: z.number(),
        windowStart: z.string(),
        windowEnd: z.string(),
        rows: z.array(modelRankingRowSchema),
      }),
    },
    summary: "Read public model usage rankings",
  },
});

const aggregateQuery$ = queryOf(aggregateModelStatsContract.aggregate);
const rankingsQuery$ = queryOf(aggregateModelStatsContract.rankings);

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
    if (get(authorization$) !== `Bearer ${cronSecret}`) {
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

const readPublicModelRankingsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const query = get(rankingsQuery$);
    const result = await set(readPublicModelRankings$, query.period, signal);

    set(setResHeader$, "Cache-Control", PUBLIC_MODEL_RANKINGS_CACHE_CONTROL);

    return {
      status: 200 as const,
      body: {
        period: result.period,
        totalTokens: result.totalTokens,
        windowStart: result.windowStart.toISOString(),
        windowEnd: result.windowEnd.toISOString(),
        rows: result.rows,
      },
    };
  },
);

export const modelStatsRoutes: readonly RouteEntry[] = [
  {
    route: aggregateModelStatsContract.aggregate,
    handler: aggregateModelStatsRoute$,
  },
  {
    route: aggregateModelStatsContract.rankings,
    handler: readPublicModelRankingsRoute$,
  },
];

export const modelStatsContract = aggregateModelStatsContract;
