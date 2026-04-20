import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { getOrgTierSafe } from "../../../../../src/lib/zero/org/org-metadata-service";
import { checkAudioInputQuota } from "../../../../../src/lib/zero/voice-io/audio-input-policy";

export async function GET(request: Request): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx || !authCtx.orgId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const tier = await getOrgTierSafe(authCtx.orgId);
  const quota = await checkAudioInputQuota(authCtx.orgId, authCtx.userId, tier);
  return NextResponse.json(quota, { status: 200 });
}
