import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { orgMembersMetadata } from "../../../../../src/db/schema/org-members-metadata";

/**
 * POST /api/zero/onboarding/complete
 *
 * Marks the member onboarding as done by writing `onboarding_done: true`
 * to the org_members table.
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

  const now = new Date();
  await globalThis.services.db
    .insert(orgMembersMetadata)
    .values({
      orgId: org.orgId,
      userId,
      onboardingDone: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        onboardingDone: true,
        updatedAt: now,
      },
    });

  return NextResponse.json({ ok: true });
}
