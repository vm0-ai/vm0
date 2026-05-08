import { NextResponse } from "next/server";
import { isApiError } from "@vm0/api-services/errors";
import { signRelayToken } from "@vm0/core/voice-chat/relay-token";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import type { AuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { checkOrgCredits } from "../../../../../src/lib/zero/credit/check-org-credits";
import { getVoiceChatCandidateSession } from "../../../../../src/lib/zero/voice-chat-candidate/session-service";
import type { VoiceChatCandidateSessionRow } from "../../../../../src/lib/zero/voice-chat-candidate/session-service";
import { buildTalkerPayload } from "../../../../../src/lib/zero/voice-chat-candidate/talker-instructions";
import {
  createEphemeralToken,
  isOpenAiTokenError,
} from "../../../../../src/lib/zero/voice-chat-candidate/openai-token";
import { loadRealtimeBillingPricing } from "../../../../../src/lib/zero/voice-chat/realtime-relay/load-pricing";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  badRequestResponse,
  forbiddenResponse,
  loadVoiceChatGates,
  notFoundResponse,
  unauthorizedResponse,
  voiceChatTokenBodySchema,
} from "../_support";
import type { VoiceChatTokenBody } from "../_support";

const log = logger("api:zero:voice-chat-candidate:token");

async function handlePost(request: Request): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) return unauthorizedResponse();

  const gates = await loadVoiceChatGates(authCtx);
  if (!gates.voiceChatEnabled) return forbiddenResponse();

  const parsed = voiceChatTokenBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  const session = await getVoiceChatCandidateSession(parsed.data.sessionId);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat-candidate session not found");
  }

  if (!gates.realtimeBillingEnabled) {
    return legacyMint(parsed.data, session);
  }
  return relayBootstrap(parsed.data, session, authCtx);
}

// Legacy branch — unchanged behaviour, narrow catch over upstream OpenAI
// failures only. Any other exception propagates to the framework error
// handler per the project's "avoid defensive programming" rule.
async function legacyMint(
  body: VoiceChatTokenBody,
  session: VoiceChatCandidateSessionRow,
): Promise<Response> {
  const { talkerInstructions } = await buildTalkerPayload(session);
  try {
    const result = await createEphemeralToken({
      instructions: talkerInstructions,
      noiseReduction: body.noiseReduction,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (isOpenAiTokenError(error)) {
      log.error("OpenAI token request failed", { status: error.status });
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

// Relay branch — credit + pricing admission, then sign and return a
// short-lived HMAC bootstrap token for the apps/api relay endpoint
// (#12139). No OpenAI client_secret is ever returned on this branch.
async function relayBootstrap(
  body: VoiceChatTokenBody,
  session: VoiceChatCandidateSessionRow,
  authCtx: AuthContext,
): Promise<Response> {
  await checkOrgCredits(session.orgId, authCtx.userId, globalThis.services.db);

  const { missing } = await loadRealtimeBillingPricing();
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: {
          message: `Voice-chat realtime pricing is not configured: ${missing.join(", ")}`,
          code: "NOT_CONFIGURED",
        },
      },
      { status: 503 },
    );
  }

  const secret = env().VOICE_CHAT_RELAY_TOKEN_SECRET;
  const apiUrl = env().VM0_API_URL;
  if (!secret || !apiUrl) {
    log.warn("Voice-chat relay bootstrap requested without secret/url", {
      hasSecret: !!secret,
      hasApiUrl: !!apiUrl,
    });
    return NextResponse.json(
      {
        error: {
          message: "Voice-chat relay is not configured",
          code: "NOT_CONFIGURED",
        },
      },
      { status: 503 },
    );
  }

  const { token, expiresAt } = signRelayToken(
    {
      voiceChatSessionId: session.id,
      userId: authCtx.userId,
      orgId: authCtx.orgId,
      noiseReduction: body.noiseReduction,
    },
    secret,
  );

  return NextResponse.json({
    relayUrl: `${apiUrl}/api/zero/voice-chat/relay`,
    relayToken: token,
    expiresAt,
    sessionId: session.id,
    transport: "websocket" as const,
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handlePost(request);
  } catch (error) {
    if (isApiError(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: error.code } },
        { status: error.statusCode },
      );
    }
    throw error;
  }
}
