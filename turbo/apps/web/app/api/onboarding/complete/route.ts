import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { orgMembersCache } from "../../../../src/db/schema/org-members-cache";

/**
 * POST /api/onboarding/complete
 *
 * Marks the member onboarding as done by writing `onboarding_done: true`
 * to Clerk membership publicMetadata and the local org_members_cache.
 */
export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { userId } = authCtx;
  const { org } = await resolveOrg(authCtx);

  // Write to Clerk membership metadata (source of truth)
  const client = await clerkClient();
  await client.organizations.updateOrganizationMembershipMetadata({
    organizationId: org.orgId,
    userId,
    publicMetadata: { onboarding_done: true },
  });

  // Update local cache
  await globalThis.services.db
    .insert(orgMembersCache)
    .values({
      orgId: org.orgId,
      userId,
      onboardingDone: true,
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: {
        onboardingDone: true,
        cachedAt: new Date(),
      },
    });

  return NextResponse.json({ ok: true });
}
