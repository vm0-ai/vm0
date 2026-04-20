import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  endVoiceChatCandidateSession,
  getVoiceChatCandidateSession,
} from "../../../../../../src/lib/zero/voice-chat-candidate/session-service";
import {
  isVoiceChatCandidateEnabled,
  notFoundResponse,
  unauthorizedResponse,
} from "../../_support";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

  // See [id]/route.ts for why this is 404 (not 403) on flag-off.
  if (!(await isVoiceChatCandidateEnabled(authCtx))) {
    return notFoundResponse("Voice-chat-candidate session not found");
  }

  const { id } = await params;
  const session = await getVoiceChatCandidateSession(id);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat-candidate session not found");
  }

  await endVoiceChatCandidateSession(id);
  return NextResponse.json({ ok: true });
}
