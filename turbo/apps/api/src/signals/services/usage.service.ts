import type {
  DailyUsage,
  UsageResponse,
} from "@vm0/api-contracts/contracts/usage";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { command } from "ccstate";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";

const MS_PER_DAY = 86_400_000;

interface UsageSummaryArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly now: Date;
  readonly startDate: Date;
  readonly endDate: Date;
}

interface AppendAgentRunsDailyArgs {
  readonly daily: DailyUsage[];
  readonly db: Db;
  readonly summary: UsageSummaryArgs;
  readonly from: Date;
  readonly to: Date;
  readonly signal: AbortSignal;
}

interface AppendHistoricalUsageArgs {
  readonly daily: DailyUsage[];
  readonly db: Db;
  readonly summary: UsageSummaryArgs;
  readonly historicalFrom: Date;
  readonly historicalTo: Date;
  readonly signal: AbortSignal;
}

function utcMidnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

async function queryAgentRunsDaily(
  db: Db,
  userId: string,
  orgId: string,
  from: Date,
  to: Date,
): Promise<DailyUsage[]> {
  if (from >= to) {
    return [];
  }

  const rows = await db
    .select({
      date: sql<string>`DATE(${agentRuns.createdAt})`.as("date"),
      run_count: sql<number>`COUNT(*)::int`.as("run_count"),
      run_time_ms:
        sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (${agentRuns.completedAt} - ${agentRuns.startedAt})) * 1000), 0)::bigint`.as(
          "run_time_ms",
        ),
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.orgId, orgId),
        gte(agentRuns.createdAt, from),
        lt(agentRuns.createdAt, to),
        isNotNull(agentRuns.completedAt),
      ),
    )
    .groupBy(sql`DATE(${agentRuns.createdAt})`);

  return rows.map((row) => {
    return {
      date: String(row.date),
      run_count: Number(row.run_count),
      run_time_ms: Number(row.run_time_ms),
    };
  });
}

async function appendAgentRunsDaily(
  args: AppendAgentRunsDailyArgs,
): Promise<void> {
  args.daily.push(
    ...(await queryAgentRunsDaily(
      args.db,
      args.summary.userId,
      args.summary.orgId,
      args.from,
      args.to,
    )),
  );
  args.signal.throwIfAborted();
}

async function cacheUsageRows(
  db: Db,
  args: UsageSummaryArgs,
  rows: readonly DailyUsage[],
): Promise<void> {
  await db
    .insert(usageDaily)
    .values(
      rows.map((row) => {
        return {
          userId: args.userId,
          orgId: args.orgId,
          date: row.date,
          runCount: row.run_count,
          runTimeMs: row.run_time_ms,
        };
      }),
    )
    .onConflictDoUpdate({
      target: [usageDaily.userId, usageDaily.orgId, usageDaily.date],
      set: {
        runCount: sql`excluded.run_count`,
        runTimeMs: sql`excluded.run_time_ms`,
        updatedAt: args.now,
      },
    });
}

async function appendHistoricalUsage(
  args: AppendHistoricalUsageArgs,
): Promise<void> {
  const fromStr = args.historicalFrom.toISOString().split("T")[0]!;
  const toStr = args.historicalTo.toISOString().split("T")[0]!;

  const cachedRows = await args.db
    .select({
      date: usageDaily.date,
      runCount: usageDaily.runCount,
      runTimeMs: usageDaily.runTimeMs,
    })
    .from(usageDaily)
    .where(
      and(
        eq(usageDaily.userId, args.summary.userId),
        eq(usageDaily.orgId, args.summary.orgId),
        gte(usageDaily.date, fromStr),
        lt(usageDaily.date, toStr),
      ),
    );
  args.signal.throwIfAborted();

  const cachedDates = new Set(
    cachedRows.map((row) => {
      return row.date;
    }),
  );
  for (const row of cachedRows) {
    args.daily.push({
      date: row.date,
      run_count: row.runCount,
      run_time_ms: Number(row.runTimeMs),
    });
  }

  const totalDays = Math.floor(
    (args.historicalTo.getTime() - args.historicalFrom.getTime()) / MS_PER_DAY,
  );
  if (cachedDates.size >= totalDays) {
    return;
  }

  const computedRows = await queryAgentRunsDaily(
    args.db,
    args.summary.userId,
    args.summary.orgId,
    args.historicalFrom,
    args.historicalTo,
  );
  args.signal.throwIfAborted();

  const uncachedRows = computedRows.filter((row) => {
    return !cachedDates.has(row.date);
  });
  args.daily.push(...uncachedRows);

  if (uncachedRows.length > 0) {
    await cacheUsageRows(args.db, args.summary, uncachedRows);
    args.signal.throwIfAborted();
  }
}

function summarizeUsage(
  args: UsageSummaryArgs,
  daily: DailyUsage[],
): UsageResponse {
  daily.sort((a, b) => {
    return b.date.localeCompare(a.date);
  });

  let totalRuns = 0;
  let totalRunTimeMs = 0;
  for (const usage of daily) {
    totalRuns += usage.run_count;
    totalRunTimeMs += usage.run_time_ms;
  }

  return {
    period: {
      start: args.startDate.toISOString(),
      end: args.endDate.toISOString(),
    },
    summary: {
      total_runs: totalRuns,
      total_run_time_ms: totalRunTimeMs,
    },
    daily,
  };
}

export const usageSummary$ = command(
  async (
    { set },
    args: UsageSummaryArgs,
    signal: AbortSignal,
  ): Promise<UsageResponse> => {
    const db = set(writeDb$);
    const todayMidnight = utcMidnight(args.now);
    const startMidnight = utcMidnight(args.startDate);
    const endMidnight = utcMidnight(args.endDate);

    const historicalFrom =
      args.startDate.getTime() === startMidnight.getTime()
        ? startMidnight
        : new Date(startMidnight.getTime() + MS_PER_DAY);
    const historicalTo =
      endMidnight < todayMidnight ? endMidnight : todayMidnight;

    const daily: DailyUsage[] = [];

    if (historicalFrom >= historicalTo) {
      await appendAgentRunsDaily({
        daily,
        db,
        summary: args,
        from: args.startDate,
        to: args.endDate,
        signal,
      });
    } else {
      await appendAgentRunsDaily({
        daily,
        db,
        summary: args,
        from: args.startDate,
        to: historicalFrom,
        signal,
      });
      await appendHistoricalUsage({
        daily,
        db,
        summary: args,
        historicalFrom,
        historicalTo,
        signal,
      });
      await appendAgentRunsDaily({
        daily,
        db,
        summary: args,
        from: historicalTo,
        to: args.endDate,
        signal,
      });
    }

    return summarizeUsage(args, daily);
  },
);
