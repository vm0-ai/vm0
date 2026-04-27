import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { getVoiceChatSession } from "../../../../../src/lib/zero/voice-chat/session-service";
import { buildTalkerPayload } from "../../../../../src/lib/zero/voice-chat/talker-instructions";
import {
  isVoiceChatEnabled,
  notFoundResponse,
  serializeVoiceChatSession,
  unauthorizedResponse,
} from "../_support";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

  // Flag-disabled tenants collapse into 404 rather than 403 here: the GET
  // contract does not list 403 in its response schema (endpoint is a read
  // path), and returning 404 avoids leaking the existence of the session
  // while still satisfying the epic's "every route gates on the flag" rule.
  // A future reader: do NOT "fix" this to 403 — keep it 404 to preserve
  // contract compliance and non-disclosure.
  if (!(await isVoiceChatEnabled(authCtx))) {
    return notFoundResponse("Voice-chat session not found");
  }

  const { id } = await params;
  const session = await getVoiceChatSession(id);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat session not found");
  }

  const talker = await buildTalkerPayload(session);

  return NextResponse.json({
    session: serializeVoiceChatSession(session),
    ...talker,
  });
}
