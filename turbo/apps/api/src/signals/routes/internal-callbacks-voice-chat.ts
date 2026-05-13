import { command } from "ccstate";
import {
  internalCallbacksVoiceChatContract,
  voiceChatCallbackPayloadSchema,
} from "@vm0/api-contracts/contracts/internal-callbacks-voice-chat";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { eq } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";
import { waitUntil } from "../context/wait-until";
import { db$, type ReadonlyDb } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  completeVoiceChatTask$,
  triggerVoiceChatReasoning$,
} from "../services/zero-voice-chat.service";
import { getRunOutputText } from "../services/run-output.service";

const log = logger("callback:voice-chat");

async function readRunInfo(
  db: ReadonlyDb,
  runId: string,
  signal: AbortSignal,
): Promise<{
  readonly agentId: string;
  readonly lastEventSequence: number | null;
}> {
  const [run] = await db
    .select({
      vars: agentRuns.vars,
      lastEventSequence: agentRuns.lastEventSequence,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();

  if (!run) {
    log.warn("run not found while resolving ZERO_AGENT_ID", { runId });
    return { agentId: "", lastEventSequence: null };
  }

  const vars = run.vars as { readonly ZERO_AGENT_ID?: unknown } | null;
  const zeroAgentId = vars?.ZERO_AGENT_ID;
  if (typeof zeroAgentId !== "string" || zeroAgentId.length === 0) {
    log.warn("vars.ZERO_AGENT_ID absent on run", { runId });
    return { agentId: "", lastEventSequence: run.lastEventSequence };
  }

  return { agentId: zeroAgentId, lastEventSequence: run.lastEventSequence };
}

const handleVoiceChatCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);
    const payload = voiceChatCallbackPayloadSchema.safeParse(callback.payload);
    if (!payload.success) {
      return {
        status: 400 as const,
        body: { error: "Invalid or missing payload" },
      };
    }

    if (callback.status === "progress") {
      return { status: 200 as const, body: { success: true as const } };
    }

    const run = await readRunInfo(get(db$), callback.runId, signal);
    signal.throwIfAborted();

    const resultText =
      callback.status === "completed"
        ? await getRunOutputText(callback.runId, {
            knownLastEventSequence: run.lastEventSequence,
            signal,
          }).catch((error: unknown) => {
            log.warn("Failed to extract run output text", {
              runId: callback.runId,
              error,
            });
            return undefined;
          })
        : undefined;
    signal.throwIfAborted();

    const completed = await set(
      completeVoiceChatTask$,
      {
        taskId: payload.data.taskId,
        result: resultText ?? null,
        error:
          callback.status === "failed"
            ? (callback.error ?? "Run failed")
            : null,
        agentId: run.agentId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!completed) {
      log.warn("voice-chat task not found - ignoring callback", {
        taskId: payload.data.taskId,
        runId: callback.runId,
      });
      return { status: 200 as const, body: { success: true as const } };
    }

    await publishUserSignal(
      [completed.session.userId],
      `voice-chat:${completed.session.id}`,
    );
    signal.throwIfAborted();
    waitUntil(set(triggerVoiceChatReasoning$, completed.session.id, signal));

    return { status: 200 as const, body: { success: true as const } };
  },
);

export const internalCallbacksVoiceChatRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksVoiceChatContract.post,
    handler: callbackRoute(handleVoiceChatCallback$),
  },
];
