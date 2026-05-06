import { computed, type Computed } from "ccstate";
import type {
  DayInsight,
  InsightsRangeResponse,
  InsightsResponse,
} from "@vm0/api-contracts/contracts/zero-insights";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { and, desc, eq, gte, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";

type DayInsightData = Partial<Omit<DayInsight, "date">>;

function normalizeDays(days: number | undefined): number {
  return Math.min(Math.max(days ?? 30, 1), 90);
}

function cutoffDateIso(days: number): string {
  const cutoff = nowDate();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString().split("T")[0]!;
}

export function zeroInsights(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly days: number | undefined;
}): Computed<Promise<InsightsResponse>> {
  return computed(async (get): Promise<InsightsResponse> => {
    const rows = await get(db$)
      .select({
        date: insightsDaily.date,
        data: insightsDaily.data,
        updatedAt: insightsDaily.updatedAt,
      })
      .from(insightsDaily)
      .where(
        and(
          eq(insightsDaily.orgId, args.orgId),
          eq(insightsDaily.userId, args.userId),
          gte(
            insightsDaily.date,
            sql`${cutoffDateIso(normalizeDays(args.days))}::date`,
          ),
        ),
      )
      .orderBy(desc(insightsDaily.date));

    const days = rows.map((row): DayInsight => {
      const data = row.data as DayInsightData;
      return {
        date: row.date,
        agents: data.agents ?? [],
        creditsUsed: data.creditsUsed ?? 0,
        creditBalance: data.creditBalance ?? 0,
        teamUsage: data.teamUsage ?? [],
        topTask: data.topTask ?? null,
        services: data.services ?? [],
        permissions: data.permissions ?? [],
        schedules: data.schedules ?? [],
        chats: data.chats ?? [],
      };
    });

    const totalCredits = days.reduce((sum, day) => {
      return sum + day.creditsUsed;
    }, 0);
    const totalRuns = days.reduce((sum, day) => {
      return (
        sum +
        day.agents.reduce((agentSum, agent) => {
          return agentSum + agent.runs;
        }, 0)
      );
    }, 0);

    const lastUpdated =
      rows.length > 0
        ? rows.reduce((latest, row) => {
            return row.updatedAt > latest ? row.updatedAt : latest;
          }, rows[0]!.updatedAt)
        : null;

    return {
      days,
      totalCredits,
      totalRuns,
      lastUpdated: lastUpdated?.toISOString() ?? null,
    };
  });
}

export function zeroInsightsRange(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<InsightsRangeResponse>> {
  return computed(async (get): Promise<InsightsRangeResponse> => {
    const [row] = await get(db$)
      .select({
        minDate: sql<string | null>`MIN(${insightsDaily.date})`.as("min_date"),
        maxDate: sql<string | null>`MAX(${insightsDaily.date})`.as("max_date"),
        totalDays: sql<number>`COUNT(*)::int`.as("total_days"),
      })
      .from(insightsDaily)
      .where(
        and(
          eq(insightsDaily.orgId, args.orgId),
          eq(insightsDaily.userId, args.userId),
        ),
      );

    if (!row || row.totalDays === 0) {
      return { minDate: null, maxDate: null, totalDays: 0 };
    }

    return {
      minDate: row.minDate,
      maxDate: row.maxDate,
      totalDays: row.totalDays,
    };
  });
}
