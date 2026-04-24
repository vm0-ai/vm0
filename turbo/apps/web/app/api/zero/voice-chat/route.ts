import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../src/lib/init-services";
import {
  createVoiceChatSession,
  listVoiceChatSessions,
} from "../../../../src/lib/zero/voice-chat/session-service";
import { buildTalkerPayload } from "../../../../src/lib/zero/voice-chat/talker-instructions";
import {
  badRequestResponse,
  createVoiceChatSessionBodySchema,
  forbiddenResponse,
  isVoiceChatEnabled,
  serializeVoiceChatSession,
  unauthorizedResponse,
} from "./_support";

export async function POST(request: Request): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

  if (!(await isVoiceChatEnabled(authCtx))) {
    return forbiddenResponse();
  }

  const parsed = createVoiceChatSessionBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  const session = await createVoiceChatSession({
    orgId: authCtx.orgId,
    userId: authCtx.userId,
    agentId: parsed.data.agentId,
  });

  const talker = await buildTalkerPayload(session);

  return NextResponse.json({
    session: serializeVoiceChatSession(session),
    ...talker,
  });
}

export async function GET(request: Request): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

  if (!(await isVoiceChatEnabled(authCtx))) {
    return forbiddenResponse();
  }

  const sessions = await listVoiceChatSessions({
    orgId: authCtx.orgId,
    userId: authCtx.userId,
  });

  return NextResponse.json({
    sessions: sessions.map((s) => {
      return serializeVoiceChatSession(s);
    }),
  });
}
