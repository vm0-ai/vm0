import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { createEphemeralToken } from "../../../../../src/lib/zero/voice-chat-candidate/openai-token";
import { logger } from "../../../../../src/lib/shared/logger";
import {
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

  try {
    const raw = await request.json().catch(() => {
      return undefined;
    });
    const body = voiceChatCandidateTokenBodySchema.parse(raw);
    const result = await createEphemeralToken(body?.model);
    return NextResponse.json(result);
  } catch (error) {
    log.error("Failed to create ephemeral token", { error });
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
}
