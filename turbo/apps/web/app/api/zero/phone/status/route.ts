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

  // Early-access: users in the allowlist see a masked phone as "verified"
  // TODO: Remove once phone verification is generally available
  const EARLY_ACCESS_USER_HASHES = ["f09d23db"];
  function fnv1a(input: string): string {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  const isEarlyAccess = EARLY_ACCESS_USER_HASHES.includes(
    fnv1a(authCtx.userId),
  );

  // Get org's phone number
  const [orgRow] = await globalThis.services.db
    .select({ agentphoneNumber: orgMetadata.agentphoneNumber })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, org.orgId))
    .limit(1);

  const userPhone = phoneLink?.verified
    ? phoneLink.phoneNumber
    : isEarlyAccess
      ? "(early access)"
      : null;

  return NextResponse.json({
    userPhone,
    userPhonePending:
      phoneLink && !phoneLink.verified ? phoneLink.phoneNumber : null,
    orgPhone: orgRow?.agentphoneNumber ?? null,
  });
}
