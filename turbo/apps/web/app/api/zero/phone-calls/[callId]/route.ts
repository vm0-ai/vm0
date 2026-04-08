import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getPhoneCallDetail } from "../../../../../src/lib/zero/phone/phone-calls-service";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:phone-calls:detail");

/**
 * GET /api/zero/phone-calls/:callId — get call detail + transcript.
 * Auth: ZERO_TOKEN (sandbox) or Clerk JWT (web UI).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ callId: string }> },
): Promise<NextResponse> {
  initServices();

  const { callId } = await params;

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
    { acceptAnySandboxCapability: true },
  );
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org } = await resolveOrg(authCtx);

  try {
    const result = await getPhoneCallDetail(org.orgId, callId);
    if (!result) {
      return NextResponse.json({ error: "Call not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    log.error("Failed to get call detail", { callId, error: err });
    return NextResponse.json(
      { error: "Failed to get call detail" },
      { status: 500 },
    );
  }
}
