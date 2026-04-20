import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { updatePreparationStatus } from "../../../../../src/lib/zero/voice-chat/preparation-service";
import type { VoiceChatPrepareCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:voice-chat-prepare");

function parsePayload(
  payload: unknown,
): VoiceChatPrepareCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.preparationId !== "string") return null;
  return { preparationId: p.preparationId };
}

/**
 * POST /api/internal/callbacks/voice-chat-prepare
 *
 * Callback handler for standalone preparation runs.
 * When the run reaches a terminal failure state, marks the preparation as
 * "failed" so the client knows it will not complete.
 *
 * Successful completion is handled by the CLI `zero voice-chat context prepare`
 * command which calls the /api/zero/voice-chat/prepare/complete endpoint.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<VoiceChatPrepareCallbackPayload>(
    request,
    log,
  );
  if (!result.ok) return result.response;

  const { runId, status } = result.data;
  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return NextResponse.json(
      { error: "Invalid or missing payload" },
      { status: 400 },
    );
  }

  // Ignore progress notifications — only act on terminal states
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  const { preparationId } = payload;

  log.debug("Processing voice-chat-prepare callback", {
    runId,
    status,
    preparationId,
  });

  // On failure/cancellation, mark the preparation as failed
  if (status !== "completed") {
    await updatePreparationStatus(preparationId, "failed");
    log.info("Preparation marked as failed", {
      preparationId,
      runId,
      status,
    });
  }

  return NextResponse.json({ success: true });
}
