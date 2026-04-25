import { NextResponse } from "next/server";
import { sql, desc, eq, and, gte } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { insightsDaily } from "@vm0/db/schema/insights-daily";

/**
 * GET /api/zero/insights
 *
 * Returns pre-aggregated daily insights for the authenticated org.
 * Query params:
 *   - days: number of days to look back from today (default 30, max 90)
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { org } = await resolveOrg(authCtx);

  const url = new URL(request.url);
  const daysParam = url.searchParams.get("days");
  const days = Math.min(Math.max(parseInt(daysParam ?? "30", 10) || 30, 1), 90);

  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffIso = cutoff.toISOString().split("T")[0]!;

  const rows = await globalThis.services.db
    .select({
      date: insightsDaily.date,
      data: insightsDaily.data,
      updatedAt: insightsDaily.updatedAt,
    })
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.orgId, org.orgId),
        eq(insightsDaily.userId, authCtx.userId),
        gte(insightsDaily.date, sql`${cutoffIso}::date`),
      ),
    )
    .orderBy(desc(insightsDaily.date));

  interface DayData {
    agents?: { runs?: number }[];
    creditsUsed?: number;
    [key: string]: unknown;
  }

  const daysData = rows.map((row) => {
    const data = row.data as DayData;
    return { date: row.date, ...data };
  });

  const totalCredits = rows.reduce((sum, row) => {
    const data = row.data as DayData;
    return sum + (data.creditsUsed ?? 0);
  }, 0);

  const totalRuns = rows.reduce((sum, row) => {
    const data = row.data as DayData;
    const agents = data.agents ?? [];
    return (
      sum +
      agents.reduce((s, a) => {
        return s + (a.runs ?? 0);
      }, 0)
    );
  }, 0);

  let lastUpdated: string | null = null;
  if (rows.length > 0) {
    let latest = rows[0]!.updatedAt;
    for (const row of rows) {
      if (row.updatedAt > latest) {
        latest = row.updatedAt;
      }
    }
    lastUpdated = latest.toISOString();
  }

  return NextResponse.json({
    days: daysData,
    totalCredits,
    totalRuns,
    lastUpdated,
  });
}
