import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../src/lib/init-services";
import { createVoiceChatCandidateSession } from "../../../../src/lib/zero/voice-chat-candidate/session-service";
import {
  badRequestResponse,
  createVoiceChatCandidateSessionBodySchema,
  forbiddenResponse,
  isVoiceChatCandidateEnabled,
  serializeVoiceChatCandidateSession,
  unauthorizedResponse,
} from "./_support";

export async function POST(request: Request): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

  if (!(await isVoiceChatCandidateEnabled(authCtx))) {
    return forbiddenResponse();
  }

  const parsed = createVoiceChatCandidateSessionBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  const session = await createVoiceChatCandidateSession({
    orgId: authCtx.orgId,
    userId: authCtx.userId,
    agentId: parsed.data.agentId,
  });

  return NextResponse.json({
    session: serializeVoiceChatCandidateSession(session),
  });
}
