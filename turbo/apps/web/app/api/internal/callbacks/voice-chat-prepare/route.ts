import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import {
  findPreparationById,
  updatePreparationStatus,
} from "../../../../../src/lib/zero/voice-chat/preparation-service";
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
 * Callback handler for preparation run completion.
 * Safety net: if the run ends and the preparation is still "preparing",
 * mark it as "failed". The normal success path goes through the
 * /api/zero/voice-chat/prepare/complete endpoint.
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

  // If preparation is still "preparing", mark it as "failed"
  const preparation = await findPreparationById(preparationId);
  if (preparation && preparation.status === "preparing") {
    await updatePreparationStatus(preparationId, "failed");
    log.info("Preparation marked as failed via callback", {
      preparationId,
      runId,
      runStatus: status,
    });
  }

  return NextResponse.json({ success: true });
}
