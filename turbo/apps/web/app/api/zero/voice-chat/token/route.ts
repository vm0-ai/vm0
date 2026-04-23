import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { getVoiceChatSession } from "../../../../../src/lib/zero/voice-chat/session-service";
import { buildTalkerPayload } from "../../../../../src/lib/zero/voice-chat/talker-instructions";
import {
  createEphemeralToken,
  isOpenAiTokenError,
} from "../../../../../src/lib/zero/voice-chat/openai-token";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  badRequestResponse,
  forbiddenResponse,
  isVoiceChatEnabled,
  notFoundResponse,
  unauthorizedResponse,
  voiceChatTokenBodySchema,
} from "../_support";

const log = logger("api:zero:voice-chat-candidate:token");

export async function POST(request: Request): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) return unauthorizedResponse();

  if (!(await isVoiceChatEnabled(authCtx))) {
    return forbiddenResponse();
  }

  const parsed = voiceChatTokenBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  const session = await getVoiceChatSession(parsed.data.sessionId);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat session not found");
  }

  const { talkerInstructions } = await buildTalkerPayload(session);

  // Narrow catch: only map upstream OpenAI failures to 500 with the documented
  // error body. Any other exception (logic bug, unavailable service, etc.)
  // propagates to the framework error handler — per project "avoid defensive
  // programming" rule.
  try {
    const result = await createEphemeralToken({
      instructions: talkerInstructions,
      noiseReduction: parsed.data.noiseReduction,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (isOpenAiTokenError(error)) {
      log.error("OpenAI token request failed", {
        status: error.status,
      });
      return NextResponse.json(
        {
          error: {
            message: "Failed to create ephemeral token",
            code: "INTERNAL_SERVER_ERROR",
          },
        },
        { status: 500 },
      );
    }
    throw error;
  }
}
