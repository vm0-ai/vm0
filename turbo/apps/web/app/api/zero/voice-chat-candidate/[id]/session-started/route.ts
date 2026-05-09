import { NextResponse } from "next/server";

import { isApiError } from "@vm0/api-services/errors";
import { voiceChatRealtimeSessions } from "@vm0/db/schema/voice-chat";

import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import { getVoiceChatSession } from "../../../../../../src/lib/zero/voice-chat/session-service";
import {
  loadVoiceChatGates,
  notFoundResponse,
  unauthorizedResponse,
} from "../../_support";

const REALTIME_PROVIDER = "openai";
const REALTIME_MODEL = "gpt-realtime-2";
const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) return unauthorizedResponse();

  const gates = await loadVoiceChatGates(authCtx);
  if (!gates.voiceChatEnabled) {
    return notFoundResponse("Voice-chat session not found");
  }
  // OFF orgs skip the audit row — there is no billing to audit yet, and
  // returning `id: null` lets the browser keep going without inventing a
  // relay-session id it can never reference.
  if (!gates.realtimeBillingEnabled) {
    return NextResponse.json({ id: null });
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

  // Plan D never has a "starting" intermediate (no relay handshake to wait
  // for); the row goes straight to `active` so subsequent /usage POSTs can
  // bump `last_usage_at` against the WHERE clause.
  const inserted = await globalThis.services.db
    .insert(voiceChatRealtimeSessions)
    .values({
      voiceChatSessionId: id,
      orgId: session.orgId,
      userId: session.userId,
      provider: REALTIME_PROVIDER,
      model: REALTIME_MODEL,
      transcriptionModel: TRANSCRIPTION_MODEL,
      status: "active",
    })
    .returning({ id: voiceChatRealtimeSessions.id });

  const row = inserted[0];
  if (!row) {
    return NextResponse.json({ id: null });
  }
  return NextResponse.json({ id: row.id });
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
