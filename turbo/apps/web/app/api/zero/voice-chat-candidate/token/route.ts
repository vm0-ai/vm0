import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  createEphemeralToken,
  isOpenAiTokenError,
} from "../../../../../src/lib/zero/voice-chat-candidate/openai-token";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  badRequestResponse,
  forbiddenResponse,
  isVoiceChatCandidateEnabled,
  unauthorizedResponse,
  voiceChatCandidateTokenBodySchema,
} from "../_support";

const log = logger("api:zero:voice-chat-candidate:token");

export async function POST(request: Request): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) return unauthorizedResponse();

  if (!(await isVoiceChatCandidateEnabled(authCtx))) {
    return forbiddenResponse();
  }

  if (!env().OPENAI_API_KEY) {
    return NextResponse.json(
      {
        error: {
          message: "OpenAI API key not configured",
          code: "SERVICE_UNAVAILABLE",
        },
      },
      { status: 503 },
    );
  }

  const parsed = voiceChatCandidateTokenBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  // Narrow catch: only map upstream OpenAI failures to 500 with the documented
  // error body. Any other exception (logic bug, unavailable service, etc.)
  // propagates to the framework error handler — per project "avoid defensive
  // programming" rule.
  try {
    const result = await createEphemeralToken(parsed.data?.model);
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
