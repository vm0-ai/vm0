import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { getAuthContext } from "../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../src/lib/zero/org/resolve-org";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { sql, and, gte, lt, eq, isNotNull } from "drizzle-orm";

/**
 * Maximum time range allowed for usage queries (30 days in milliseconds)
 */
const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Default time range (7 days in milliseconds)
 */
const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

const MS_PER_DAY = 86400000;

interface DailyUsage {
  date: string;
  run_count: number;
  run_time_ms: number;
}

interface UsageResponse {
  period: {
    start: string;
    end: string;
  };
  summary: {
    total_runs: number;
    total_run_time_ms: number;
  };
  daily: DailyUsage[];
}

function utcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

async function queryAgentRunsDaily(
  db: typeof globalThis.services.db,
  userId: string,
  orgId: string,
  from: Date,
  to: Date,
): Promise<DailyUsage[]> {
  if (from >= to) return [];

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

/**
 * GET /api/usage
 *
 * Query parameters:
 * - start_date: ISO date string (default: 7 days ago)
 * - end_date: ISO date string (default: now)
 *
 * Returns daily aggregated usage statistics for the authenticated user.
 * Uses a dual-path strategy: cached usage_daily for historical complete days
 * (populated by cron or on-demand), real-time agent_runs for boundary days
 * and today. Missing cache entries are computed and stored on first access.
 */
export async function GET(request: NextRequest) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("Authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId } = authCtx;

  // Resolve org context
  const { org } = await resolveOrg(authCtx);

  // Parse query parameters
  const searchParams = request.nextUrl.searchParams;
  const startDateParam = searchParams.get("start_date");
  const endDateParam = searchParams.get("end_date");

  // Calculate date range
  const now = new Date();
  let endDate: Date;
  let startDate: Date;

  if (endDateParam) {
    endDate = new Date(endDateParam);
    if (isNaN(endDate.getTime())) {
      return NextResponse.json(
        {
          error: {
            message: "Invalid end_date format. Use ISO 8601 format.",
            code: "BAD_REQUEST",
          },
        },
        { status: 400 },
      );
    }
  } else {
    endDate = now;
  }

  if (startDateParam) {
    startDate = new Date(startDateParam);
    if (isNaN(startDate.getTime())) {
      return NextResponse.json(
        {
          error: {
            message: "Invalid start_date format. Use ISO 8601 format.",
            code: "BAD_REQUEST",
          },
        },
        { status: 400 },
      );
    }
  } else {
    startDate = new Date(endDate.getTime() - DEFAULT_RANGE_MS);
  }

  // Validate date range
  if (startDate >= endDate) {
    return NextResponse.json(
      {
        error: {
          message: "start_date must be before end_date",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const rangeMs = endDate.getTime() - startDate.getTime();
  if (rangeMs > MAX_RANGE_MS) {
    return NextResponse.json(
      {
        error: {
          message:
            "Time range exceeds maximum of 30 days. Use --until to specify an end date.",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // Hybrid query: usage_daily for complete historical days, agent_runs for boundaries
  const db = globalThis.services.db;
  const todayMidnight = utcMidnight(now);
  const startMidnight = utcMidnight(startDate);
  const endMidnight = utcMidnight(endDate);

  // Complete historical day range: days fully within [startDate, endDate) and before today
  const historicalFrom =
    startDate.getTime() === startMidnight.getTime()
      ? startMidnight
      : new Date(startMidnight.getTime() + MS_PER_DAY);
  const historicalTo =
    endMidnight < todayMidnight ? endMidnight : todayMidnight;

  const daily: DailyUsage[] = [];

  if (historicalFrom >= historicalTo) {
    // No complete historical days — use agent_runs for entire range
    daily.push(
      ...(await queryAgentRunsDaily(db, userId, org.orgId, startDate, endDate)),
    );
  } else {
    // Part 1: partial start day from agent_runs [startDate, historicalFrom)
    daily.push(
      ...(await queryAgentRunsDaily(
        db,
        userId,
        org.orgId,
        startDate,
        historicalFrom,
      )),
    );

    // Part 2: complete historical days — dual-path (cache + on-demand compute)
    const fromStr = historicalFrom.toISOString().split("T")[0]!;
    const toStr = historicalTo.toISOString().split("T")[0]!;

    // 2a. Check cache (usage_daily)
    const cachedRows = await db
      .select({
        date: usageDaily.date,
        runCount: usageDaily.runCount,
        runTimeMs: usageDaily.runTimeMs,
      })
      .from(usageDaily)
      .where(
        and(
          eq(usageDaily.userId, userId),
          eq(usageDaily.orgId, org.orgId),
          gte(usageDaily.date, fromStr),
          lt(usageDaily.date, toStr),
        ),
      );

    const cachedDates = new Set(
      cachedRows.map((r) => {
        return r.date;
      }),
    );

    for (const row of cachedRows) {
      daily.push({
        date: row.date,
        run_count: row.runCount,
        run_time_ms: Number(row.runTimeMs),
      });
    }

    // 2b. On-demand compute for missing days from agent_runs
    const totalDays = Math.floor(
      (historicalTo.getTime() - historicalFrom.getTime()) / MS_PER_DAY,
    );

    if (cachedDates.size < totalDays) {
      const computedRows = await queryAgentRunsDaily(
        db,
        userId,
        org.orgId,
        historicalFrom,
        historicalTo,
      );

      const uncachedRows = computedRows.filter((row) => {
        return !cachedDates.has(row.date);
      });
      daily.push(...uncachedRows);

      // Batch cache for next time (single upsert instead of N)
      if (uncachedRows.length > 0) {
        await db
          .insert(usageDaily)
          .values(
            uncachedRows.map((row) => {
              return {
                userId,
                orgId: org.orgId,
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
              updatedAt: new Date(),
            },
          });
      }
    }

    // Part 3: today + partial end day from agent_runs [historicalTo, endDate)
    daily.push(
      ...(await queryAgentRunsDaily(
        db,
        userId,
        org.orgId,
        historicalTo,
        endDate,
      )),
    );
  }

  // Sort descending by date and calculate totals
  daily.sort((a, b) => {
    return b.date.localeCompare(a.date);
  });

  let totalRuns = 0;
  let totalRunTimeMs = 0;
  for (const d of daily) {
    totalRuns += d.run_count;
    totalRunTimeMs += d.run_time_ms;
  }

  const response: UsageResponse = {
    period: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
    summary: {
      total_runs: totalRuns,
      total_run_time_ms: totalRunTimeMs,
    },
    daily,
  };

  return NextResponse.json(response);
}
