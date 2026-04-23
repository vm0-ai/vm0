import { NextResponse, after } from "next/server";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import { getVoiceChatSession } from "../../../../../../src/lib/zero/voice-chat/session-service";
import { triggerReasoning } from "../../../../../../src/lib/zero/voice-chat/trigger-reasoning";
import {
  isVoiceChatEnabled,
  notFoundResponse,
  unauthorizedResponse,
} from "../../_support";

export const maxDuration = 60;

/**
 * Queue a reasoner tick on demand — typically invoked by the UI "Compact"
 * button. The request is fire-and-forget: we return 200 immediately and run
 * `triggerReasoning` after the response, which then goes through the normal
 * CAS lock / debounce / compactor pipeline. A losing-racer tick sets
 * `reasoning_pending` and drains after the current holder finishes.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

  if (!(await isVoiceChatEnabled(authCtx))) {
    return notFoundResponse("Session not found or not active");
  }

  const { id } = await params;
  const session = await getVoiceChatSession(id);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Session not found");
  }

  after(() => {
    return triggerReasoning(id);
  });

  return NextResponse.json({ ok: true });
}
