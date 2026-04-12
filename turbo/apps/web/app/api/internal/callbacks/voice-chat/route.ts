import { NextRequest, NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import {
  voiceChatSessions,
  voiceChatEvents,
} from "../../../../../src/db/schema/voice-chat";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { getRunOutputText } from "../../../../../src/lib/infra/run/extract-run-output";
import { saveRunSummary } from "../../../../../src/lib/zero/run-summary";
import type { VoiceChatCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:voice-chat");

function parsePayload(payload: unknown): VoiceChatCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.sessionId !== "string") return null;
  return { sessionId: p.sessionId };
}

/**
 * POST /api/internal/callbacks/voice-chat
 *
 * Voice-chat callback handler for slow-brain run completion.
 * When the run reaches a terminal state, ends the voice-chat session
 * (if still active) and generates a run summary.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<VoiceChatCallbackPayload>(request, log);
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

  const { sessionId } = payload;
  const db = globalThis.services.db;

  log.debug("Processing voice-chat callback", { runId, status, sessionId });

  // End session if still active/preparing
  const [session] = await db
    .select({ id: voiceChatSessions.id, status: voiceChatSessions.status })
    .from(voiceChatSessions)
    .where(
      and(
        eq(voiceChatSessions.id, sessionId),
        inArray(voiceChatSessions.status, ["active", "preparing"]),
      ),
    )
    .limit(1);

  if (session) {
    await db.transaction(async (tx) => {
      await tx.insert(voiceChatEvents).values({
        sessionId,
        source: "system",
        type: "session-end",
      });
      await tx
        .update(voiceChatSessions)
        .set({ status: "ended", endedAt: new Date() })
        .where(eq(voiceChatSessions.id, sessionId));
    });
    log.info("Voice-chat session ended via callback", { sessionId, runId });
  }

  // Generate run summary (best-effort)
  if (status === "completed") {
    const [run] = await db
      .select({ prompt: agentRuns.prompt })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (run) {
      const resultText = await getRunOutputText(runId).catch((err: unknown) => {
        log.warn("Failed to extract run output text", { runId, err });
        return undefined;
      });
      await saveRunSummary(runId, "voice-chat", run.prompt, resultText ?? "");
    }
  }

  return NextResponse.json({ success: true });
}
