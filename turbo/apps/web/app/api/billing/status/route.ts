import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { getBillingStatus } from "../../../../src/lib/billing/billing-service";

/**
 * GET /api/billing/status
 *
 * Get billing status for the current org.
 * Returns: { tier, credits, subscriptionStatus, currentPeriodEnd, hasSubscription }
 */
export async function GET(request: Request) {
  initServices();

  const authResult = await requireAuth(
    request.headers.get("authorization") ?? undefined,
  );
  if (isAuthError(authResult)) {
    return NextResponse.json(authResult.body, { status: authResult.status });
  }

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org } = await resolveOrg(authResult, orgSlug);

  const status = await getBillingStatus(org.orgId);

  return NextResponse.json(status);
}
