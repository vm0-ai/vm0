import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../../src/lib/init-services";
import { getVoiceChatCandidateSession } from "../../../../../../../src/lib/zero/voice-chat-candidate/session-service";
import { listTranscriptByRole } from "../../../../../../../src/lib/zero/voice-chat-candidate/item-service";
import {
  badRequestResponse,
  isVoiceChatCandidateEnabled,
  notFoundResponse,
  serializeVoiceChatCandidateItem,
  unauthorizedResponse,
} from "../../../_support";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

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

  const sinceParam = new URL(request.url).searchParams.get("sinceSeq");
  const sinceSeq = sinceParam !== null ? Number(sinceParam) : undefined;
  if (sinceSeq !== undefined && !Number.isFinite(sinceSeq)) {
    return badRequestResponse("Invalid 'sinceSeq' query parameter");
  }

  const items = await listTranscriptByRole(id, "task_result", sinceSeq);
  return NextResponse.json({
    items: items.map((i) => {
      return serializeVoiceChatCandidateItem(i);
    }),
  });
}
