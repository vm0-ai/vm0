import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";
import { phoneUserLinks } from "../../../../../src/db/schema/phone-user-link";

export async function GET(request: Request): Promise<NextResponse> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org } = await resolveOrg(authCtx);

  const [phoneLink] = await globalThis.services.db
    .select({
      phoneNumber: phoneUserLinks.phoneNumber,
      verified: phoneUserLinks.verified,
    })
    .from(phoneUserLinks)
    .where(
      and(
        eq(phoneUserLinks.orgId, org.orgId),
        eq(phoneUserLinks.vm0UserId, authCtx.userId),
      ),
    )
    .limit(1);

  // Get org's phone number
  const [orgRow] = await globalThis.services.db
    .select({ agentphoneNumber: orgMetadata.agentphoneNumber })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, org.orgId))
    .limit(1);

  const userPhone = phoneLink?.verified ? phoneLink.phoneNumber : null;

  return NextResponse.json({
    userPhone,
    userPhonePending:
      phoneLink && !phoneLink.verified ? phoneLink.phoneNumber : null,
    orgPhone: orgRow?.agentphoneNumber ?? null,
  });
}
