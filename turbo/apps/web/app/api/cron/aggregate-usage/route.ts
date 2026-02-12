import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { sql } from "drizzle-orm";
import { env } from "../../../../src/env";

export async function GET(request: Request): Promise<Response> {
  initServices();

  // Verify cron secret (Vercel automatically injects CRON_SECRET into Authorization header)
  const authHeader = request.headers.get("authorization");
  const cronSecret = env().CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  // Calculate yesterday's date range in UTC
  const now = new Date();
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const targetDate = yesterday.toISOString().split("T")[0]!;

  // Aggregate completed runs from yesterday and upsert daily usage in one query
  const result = await globalThis.services.db.execute(sql`
    INSERT INTO usage_daily (user_id, date, run_count, run_time_ms)
    SELECT
      ${agentRuns.userId},
      ${targetDate}::date,
      COUNT(*)::int,
      COALESCE(SUM(EXTRACT(EPOCH FROM (${agentRuns.completedAt} - ${agentRuns.startedAt})) * 1000), 0)::bigint
    FROM ${agentRuns}
    WHERE ${agentRuns.createdAt} >= ${yesterday}
      AND ${agentRuns.createdAt} < ${today}
      AND ${agentRuns.completedAt} IS NOT NULL
    GROUP BY ${agentRuns.userId}
    ON CONFLICT (user_id, date) DO UPDATE SET
      run_count = EXCLUDED.run_count,
      run_time_ms = EXCLUDED.run_time_ms,
      updated_at = NOW()
  `);

  return NextResponse.json({
    date: targetDate,
    aggregated: result.rowCount ?? 0,
  });
}
