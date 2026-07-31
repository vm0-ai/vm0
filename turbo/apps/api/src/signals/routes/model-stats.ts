import { initContract } from "@vm0/api-contracts/contracts/trpc-contract";
import { cronAggregateModelStatsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import { authorization$, setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  aggregateModelStats$,
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

export const modelStatsContract = c.router({
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

const rankingsQuery$ = queryOf(modelStatsContract.rankings);

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

    const result = await set(aggregateModelStats$, signal);
    return {
      status: 200 as const,
      body: {
        success: true as const,
        cutoff: result.cutoff.toISOString(),
        processedHours: result.processedHours,
        processedObservations: result.processedObservations,
        updatedStats: result.updatedStats,
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
    route: cronAggregateModelStatsContract.aggregate,
    handler: aggregateModelStatsRoute$,
  },
  {
    route: modelStatsContract.rankings,
    handler: readPublicModelRankingsRoute$,
  },
];
