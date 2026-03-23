import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { getUsageMembers } from "../../../../src/lib/billing/usage-service";

/**
 * GET /api/usage/members
 *
 * Returns per-member token usage aggregation for the current billing period.
 * Only includes credit_usage records with status = 'processed'.
 * Free tier orgs (no billing period) get { period: null, members: [] }.
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

  const response = await getUsageMembers(org.orgId);
  return NextResponse.json(response);
}
