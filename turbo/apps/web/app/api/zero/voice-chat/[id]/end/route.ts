import { NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { endSession } from "../../../../../../src/lib/zero/voice-chat/session-service";
import { isApiError } from "../../../../../../src/lib/shared/errors";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:zero:voice-chat:end");

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { org } = await resolveOrg(authCtx);
  const { id } = await params;

  try {
    await endSession(id, org.orgId, authCtx.userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isApiError(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: error.code } },
        { status: error.statusCode },
      );
    }
    log.error("Failed to end voice-chat session", error);
    throw error;
  }
}
