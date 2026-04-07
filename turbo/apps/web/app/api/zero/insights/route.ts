import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { insightsDaily } from "../../../../src/db/schema/insights-daily";

/**
 * GET /api/zero/insights
 *
 * Returns pre-aggregated daily insights for the authenticated org.
 * Query params:
 *   - days: number of days to return (default 30, max 90)
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

  const rows = await globalThis.services.db
    .select({ date: insightsDaily.date, data: insightsDaily.data })
    .from(insightsDaily)
    .where(eq(insightsDaily.orgId, org.orgId))
    .orderBy(desc(insightsDaily.date))
    .limit(days);

  interface DayData {
    agents?: Array<{ runs?: number }>;
    creditsUsed?: number;
  }

  const daysData = rows.map((row) => {
    return { date: row.date, ...(row.data as Record<string, unknown>) };
  });

  const totalCredits = rows.reduce((sum, row) => {
    return sum + ((row.data as DayData).creditsUsed ?? 0);
  }, 0);

  const totalRuns = rows.reduce((sum, row) => {
    const agents = (row.data as DayData).agents ?? [];
    return (
      sum +
      agents.reduce((s, a) => {
        return s + (a.runs ?? 0);
      }, 0)
    );
  }, 0);

  return NextResponse.json({
    days: daysData,
    totalCredits,
    totalRuns,
  });
}
