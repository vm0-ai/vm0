import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  getVoiceChatCandidateSession,
  reactivateVoiceChatCandidateSession,
} from "../../../../../../src/lib/zero/voice-chat-candidate/session-service";
import { buildTalkerPayload } from "../../../../../../src/lib/zero/voice-chat-candidate/talker-instructions";
import {
  forbiddenResponse,
  isVoiceChatCandidateEnabled,
  notFoundResponse,
  serializeVoiceChatCandidateSession,
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

  if (!(await isVoiceChatCandidateEnabled(authCtx))) {
    return forbiddenResponse();
  }

  const { id } = await params;
  const existing = await getVoiceChatCandidateSession(id);
  if (
    !existing ||
    existing.orgId !== authCtx.orgId ||
    existing.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat-candidate session not found");
  }

  const session = await reactivateVoiceChatCandidateSession(id);
  const talker = await buildTalkerPayload(session);

  return NextResponse.json({
    session: serializeVoiceChatCandidateSession(session),
    ...talker,
  });
}
