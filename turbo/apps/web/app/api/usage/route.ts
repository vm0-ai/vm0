import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { agentRuns } from "../../../src/db/schema/agent-run";
import { sql, and, gte, lt, eq, isNotNull } from "drizzle-orm";

/**
 * Maximum time range allowed for usage queries (30 days in milliseconds)
 */
const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Default time range (7 days in milliseconds)
 */
const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * GET /api/usage
 *
 * Query parameters:
 * - start_date: ISO date string (default: 7 days ago)
 * - end_date: ISO date string (default: now)
 *
 * Returns daily aggregated usage statistics for the authenticated user.
 */
export async function GET(request: NextRequest) {
  initServices();

  const userId = await getUserId(
    request.headers.get("Authorization") ?? undefined,
  );
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

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

  // Query daily aggregation
  // Using raw SQL for DATE() function and aggregation
  const dailyResults = await globalThis.services.db
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
        gte(agentRuns.createdAt, startDate),
        lt(agentRuns.createdAt, endDate),
        isNotNull(agentRuns.completedAt),
      ),
    )
    .groupBy(sql`DATE(${agentRuns.createdAt})`)
    .orderBy(sql`DATE(${agentRuns.createdAt}) DESC`);

  // Calculate totals
  let totalRuns = 0;
  let totalRunTimeMs = 0;

  const daily: DailyUsage[] = dailyResults.map((row) => {
    const runCount = Number(row.run_count);
    const runTimeMs = Number(row.run_time_ms);
    totalRuns += runCount;
    totalRunTimeMs += runTimeMs;
    return {
      date: String(row.date),
      run_count: runCount,
      run_time_ms: runTimeMs,
    };
  });

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
