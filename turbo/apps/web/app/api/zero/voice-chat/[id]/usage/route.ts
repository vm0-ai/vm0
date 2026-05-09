import { NextResponse } from "next/server";

import { isApiError } from "@vm0/api-services/errors";
import { voiceChatUsageEventBodySchema } from "@vm0/api-contracts/contracts/zero-voice-chat";

import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import { getVoiceChatSession } from "../../../../../../src/lib/zero/voice-chat/session-service";
import { recordRealtimeUsage } from "../../../../../../src/lib/zero/voice-chat/usage-event-service";
import {
  badRequestResponse,
  loadVoiceChatGates,
  notFoundResponse,
  unauthorizedResponse,
} from "../../_support";

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) return unauthorizedResponse();

  // Trinity gate: 404 (not 403) on flag-off mirrors the rest of the
  // /[id]/* family — non-rolled-out orgs can't tell the endpoint exists.
  const gates = await loadVoiceChatGates(authCtx);
  if (!gates.voiceChatEnabled) {
    return notFoundResponse("Voice-chat session not found");
  }

  // VoiceChatRealtimeBilling OFF: 200 no-op so browser code stays uniform
  // ON or OFF. Server still records the call in logs for audit.
  if (!gates.realtimeBillingEnabled) {
    return NextResponse.json({ creditsExhausted: false });
  }

  const parsed = voiceChatUsageEventBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  // Transcription doesn't produce assistant audio output; reject the field
  // so accidental browser bugs surface as 400 instead of silently inserting
  // a gpt-4o-mini-transcribe `tokens.output.audio` row that no pricing
  // covers (would emit a `missing_pricing` billing error).
  if (
    parsed.data.eventType === "transcription.completed" &&
    parsed.data.outputAudioTokens !== undefined
  ) {
    return badRequestResponse(
      "transcription.completed cannot include outputAudioTokens",
    );
  }

  const { id } = await params;
  const session = await getVoiceChatSession(id);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat session not found");
  }

  const result = await recordRealtimeUsage({
    voiceChatSessionId: id,
    orgId: session.orgId,
    userId: session.userId,
    providerEventId: parsed.data.providerEventId,
    eventType: parsed.data.eventType,
    tokens: {
      inputText: parsed.data.inputTextTokens,
      inputAudio: parsed.data.inputAudioTokens,
      inputCachedText: parsed.data.inputCachedTextTokens,
      inputCachedAudio: parsed.data.inputCachedAudioTokens,
      outputText: parsed.data.outputTextTokens,
      outputAudio: parsed.data.outputAudioTokens,
    },
  });

  return NextResponse.json({ creditsExhausted: result.creditsExhausted });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    return await handlePost(request, context);
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
