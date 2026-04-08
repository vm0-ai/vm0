import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getUserPhoneLink } from "../../../../../src/lib/zero/phone/phone-verify-service";
import { eq } from "drizzle-orm";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";

export async function GET(request: Request): Promise<NextResponse> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org } = await resolveOrg(authCtx);

  const phoneLink = await getUserPhoneLink(org.orgId, authCtx.userId);

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
