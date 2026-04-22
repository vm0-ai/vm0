import { NextRequest, NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { voiceChatSessions } from "../../../../../src/db/schema/voice-chat";
import { getRunOutputText } from "../../../../../src/lib/infra/run/extract-run-output";
import {
  appendTaskEvent,
  completeVoiceChatTask,
  type VoiceChatTaskTerminalStatus,
} from "../../../../../src/lib/zero/voice-chat/task-service";
import { publishUserSignal } from "../../../../../src/lib/infra/realtime/client";
import type { VoiceChatTaskCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:voice-chat-task");

export const maxDuration = 60;

function parsePayload(payload: unknown): VoiceChatTaskCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.taskId !== "string") return null;
  return { taskId: p.taskId };
}

function mapRunStatus(runStatus: string): {
  taskStatus: VoiceChatTaskTerminalStatus;
  defaultError: string | null;
} {
  if (runStatus === "completed") {
    return { taskStatus: "done", defaultError: null };
  }
  if (runStatus === "cancelled") {
    return { taskStatus: "failed", defaultError: "Run cancelled" };
  }
  if (runStatus === "timeout") {
    return { taskStatus: "failed", defaultError: "Run timeout" };
  }
  return { taskStatus: "failed", defaultError: "Run failed" };
}

/**
 * POST /api/internal/callbacks/voice-chat-task
 *
 * Terminal-status callback for voice-chat task runs. On terminal status the
 * task row is updated with result/error, a `task-completed` system event is
 * written to the blackboard, and the user's Ably signal channel is pinged so
 * the slow-brain CLI wakes up without waiting for its next poll tick.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<VoiceChatTaskCallbackPayload>(
    request,
    log,
  );
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;
  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return NextResponse.json(
      { error: "Invalid or missing payload" },
      { status: 400 },
    );
  }

  // Streaming assistant-message notifications are Phase 2; the dispatched
  // event already told slow-brain the task is running.
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  const { taskStatus, defaultError } = mapRunStatus(status);
  const resultText =
    taskStatus === "done"
      ? await getRunOutputText(runId).catch((err: unknown) => {
          log.warn("Failed to extract run output text", { runId, err });
          return undefined;
        })
      : undefined;
  const errorText = taskStatus === "failed" ? (error ?? defaultError) : null;

  const completed = await completeVoiceChatTask({
    taskId: payload.taskId,
    status: taskStatus,
    result: resultText ?? null,
    error: errorText,
  });

  if (!completed) {
    log.warn("voice-chat task not found — ignoring callback", {
      taskId: payload.taskId,
      runId,
    });
    return NextResponse.json({ success: true });
  }

  await appendTaskEvent(completed.sessionId, "task-completed", completed.id);

  const [session] = await globalThis.services.db
    .select({ userId: voiceChatSessions.userId })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, completed.sessionId))
    .limit(1);

  if (session) {
    after(() => {
      return publishUserSignal(
        [session.userId],
        `voice:${completed.sessionId}`,
      );
    });
  }

  return NextResponse.json({ success: true });
}
