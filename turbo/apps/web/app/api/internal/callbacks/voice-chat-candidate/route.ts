import { NextRequest, NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { getRunOutputText } from "../../../../../src/lib/infra/run/extract-run-output";
import { completeVoiceChatCandidateTask } from "../../../../../src/lib/zero/voice-chat-candidate/task-service";
import { triggerReasoning } from "../../../../../src/lib/zero/voice-chat-candidate/trigger-reasoning";
import { publishUserSignal } from "../../../../../src/lib/infra/realtime/client";
import { dispatchCancelSideEffects } from "../../../../../src/lib/infra/run/run-service";
import type { CancelRunResult } from "../../../../../src/lib/zero/zero-run-cancel";
import {
  dispatchQueuedZeroRun,
  drainOrgQueue,
} from "../../../../../src/lib/zero/zero-run-queue-service";
import { processOrgCredits } from "../../../../../src/lib/zero/credit/credit-service";
import { processOrgUsageEvents } from "../../../../../src/lib/zero/credit/usage-event-service";
import { isNotFound } from "@vm0/api-services/errors";
import type { VoiceChatCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:voice-chat-candidate");

export const maxDuration = 60;

function parsePayload(payload: unknown): VoiceChatCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.taskId !== "string") return null;
  return { taskId: p.taskId };
}

async function readRunAgentId(runId: string): Promise<string> {
  const [run] = await globalThis.services.db
    .select({ vars: agentRuns.vars })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    log.warn("run not found while resolving ZERO_AGENT_ID", { runId });
    return "";
  }

  const vars = run.vars as { ZERO_AGENT_ID?: unknown } | null;
  const zeroAgentId = vars?.ZERO_AGENT_ID;
  if (typeof zeroAgentId !== "string" || zeroAgentId.length === 0) {
    log.warn("vars.ZERO_AGENT_ID absent on run", { runId });
    return "";
  }

  return zeroAgentId;
}

/**
 * POST /api/internal/callbacks/voice-chat-candidate
 *
 * Task-run callback for the voice-chat-candidate surface (Epic #10297, Wave 5).
 * On terminal status, completes the task, then post-response kicks the
 * Reasoner and pokes the user's Ably channel so the browser picks up the
 * terminal transition even if the Reasoner is a no-op.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<VoiceChatCallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;
  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return NextResponse.json(
      { error: "Invalid or missing payload" },
      { status: 400 },
    );
  }

  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  const agentId = await readRunAgentId(runId);

  const resultText =
    status === "completed"
      ? await getRunOutputText(runId).catch((err: unknown) => {
          log.warn("Failed to extract run output text", { runId, err });
          return undefined;
        })
      : undefined;
  const errorText = status === "failed" ? (error ?? "Run failed") : null;

  let sessionId: string;
  let userId: string;
  let cancelledRuns: CancelRunResult[];
  try {
    const outcome = await completeVoiceChatCandidateTask({
      taskId: payload.taskId,
      result: resultText ?? null,
      error: errorText,
      agentId,
    });
    sessionId = outcome.session.id;
    userId = outcome.session.userId;
    cancelledRuns = outcome.cancelledRuns;
  } catch (err) {
    if (isNotFound(err)) {
      log.warn("voice-chat-candidate task not found — ignoring callback", {
        taskId: payload.taskId,
        runId,
      });
      return NextResponse.json({ success: true });
    }
    throw err;
  }

  // Fast path: the task row just flipped to done/failed and the task_result
  // item is already written. Publish before returning so the browser can
  // refresh the Talker instruction against the updated DB-backed Task board
  // — without waiting for the reasoner LLM. The after() reasoner tick still
  // runs and will publish again once it has new conversation summary /
  // compacted results.
  await publishUserSignal([userId], `voice-chat-candidate:${sessionId}`);
  after(() => {
    return triggerReasoning(sessionId);
  });

  // Mismatch path cancelled one or more pending/queued runs. Dispatch the
  // side effects (Ably cancel, registered callbacks, queue drain) once per
  // run, then process org credits + usage events once for the batch —
  // all cancelled runs share the session's org.
  if (cancelledRuns.length > 0) {
    const orgId = cancelledRuns[0]!.orgId;
    after(async () => {
      let anyActive = false;
      for (const result of cancelledRuns) {
        const active = await dispatchCancelSideEffects(result, (oid) => {
          return drainOrgQueue(oid, dispatchQueuedZeroRun);
        });
        if (active) anyActive = true;
      }
      if (anyActive) {
        await processOrgCredits(orgId);
        await processOrgUsageEvents(orgId);
      }
    });
  }

  return NextResponse.json({ success: true });
}
