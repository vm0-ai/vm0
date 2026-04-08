import { NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { heartbeat } from "../../../../../../src/lib/zero/voice-chat/session-service";

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
  const updated = await heartbeat(id, org.orgId, authCtx.userId);
  if (!updated) {
    return NextResponse.json(
      {
        error: {
          message: "Session not found or not active",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
