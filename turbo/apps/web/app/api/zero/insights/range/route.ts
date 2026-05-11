import { NextResponse } from "next/server";
import { sql, eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { insightsDaily } from "@vm0/db/schema/insights-daily";

/**
 * GET /api/zero/insights/range
 *
 * Returns the date range of available insights for the authenticated org.
 * Used by the frontend to determine which date filter options to display.
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
  if (!authCtx.orgId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { org } = await resolveOrg(authCtx);

  const [row] = await globalThis.services.db
    .select({
      minDate: sql<string>`MIN(${insightsDaily.date})`.as("min_date"),
      maxDate: sql<string>`MAX(${insightsDaily.date})`.as("max_date"),
      totalDays: sql<number>`COUNT(*)::int`.as("total_days"),
    })
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.orgId, org.orgId),
        eq(insightsDaily.userId, authCtx.userId),
      ),
    );

  if (!row || row.totalDays === 0) {
    return NextResponse.json({ minDate: null, maxDate: null, totalDays: 0 });
  }

  return NextResponse.json({
    minDate: row.minDate,
    maxDate: row.maxDate,
    totalDays: row.totalDays,
  });
}
