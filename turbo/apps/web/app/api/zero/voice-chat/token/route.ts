import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { isApiError } from "@vm0/api-services/errors";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { checkOrgCredits } from "../../../../../src/lib/zero/credit/check-org-credits";
import { getVoiceChatSession } from "../../../../../src/lib/zero/voice-chat/session-service";
import { buildTalkerPayload } from "../../../../../src/lib/zero/voice-chat/talker-instructions";
import {
  createEphemeralToken,
  isOpenAiTokenError,
} from "../../../../../src/lib/zero/voice-chat/openai-token";
import { loadRealtimeBillingPricing } from "../../../../../src/lib/zero/voice-chat/load-realtime-pricing";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  badRequestResponse,
  forbiddenResponse,
  loadVoiceChatGates,
  notFoundResponse,
  unauthorizedResponse,
  voiceChatTokenBodySchema,
} from "../_support";

const log = logger("api:zero:voice-chat:token");
const MAX_UPSTREAM_ERROR_BODY_LENGTH = 2_000;

function safetyIdentifierForUser(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

function truncateUpstreamBody(body: string): string {
  if (body.length <= MAX_UPSTREAM_ERROR_BODY_LENGTH) {
    return body;
  }
  return body.slice(0, MAX_UPSTREAM_ERROR_BODY_LENGTH);
}

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

  const session = await getVoiceChatSession(parsed.data.sessionId);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat session not found");
  }

  // Admission gate when realtime billing is on. Stays gated on the switch
  // so OFF orgs keep the legacy unmetered behaviour.
  if (gates.realtimeBillingEnabled) {
    await checkOrgCredits(
      session.orgId,
      authCtx.userId,
      globalThis.services.db,
    );
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
  }

  const { talkerInstructions } = await buildTalkerPayload(session);
  try {
    const result = await createEphemeralToken({
      instructions: talkerInstructions,
      noiseReduction: parsed.data.noiseReduction,
      safetyIdentifier: safetyIdentifierForUser(authCtx.userId),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (isOpenAiTokenError(error)) {
      log.error("OpenAI token request failed", {
        status: error.status,
        upstreamBody: truncateUpstreamBody(error.body),
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
