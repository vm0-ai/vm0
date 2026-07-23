import { triggerSourceSchema } from "@vm0/api-contracts/contracts/logs";
import {
  zeroWorkflows,
  zeroWorkflowAutomations,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import { publishChatThreadWorkflowQueueChangedSafely } from "../external/realtime";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import {
  claimNextWorkflowQueueEvent,
  decryptWorkflowQueueEventParams,
  restoreWorkflowQueueEventAndPause,
  type ClaimedWorkflowQueueEvent,
} from "./chat-message-queue.service";
import { runWorkflowAutomationNow$ } from "./zero-workflow-automation-run.service";

const log = logger("ZeroWorkflowQueueDrain");

// Consecutive stale events (deleted/disabled automations) skipped per drain call
// before giving up; a successful run creation always stops the loop.
const MAX_DRAIN_ATTEMPTS = 5;

interface DequeueTarget {
  readonly automation: typeof zeroWorkflowAutomations.$inferSelect;
  readonly agentId: string;
  readonly workflowName: string;
}

async function loadDequeueTarget(
  db: Db,
  event: ClaimedWorkflowQueueEvent,
): Promise<DequeueTarget | null> {
  const [row] = await db
    .select({
      automation: zeroWorkflowAutomations,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .where(
      and(
        eq(zeroWorkflowAutomations.id, event.automationId),
        eq(zeroWorkflowAutomations.orgId, event.orgId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Advance the thread's workflow queue: as long as user queued messages always
 * win (enforced inside `claimNextWorkflowQueueEvent`), pop the oldest event
 * and turn it into a run. Events whose automation disappeared or can no longer
 * fire are consumed and skipped; a run-creation failure restores the event to
 * the queue head and pauses the queue so the backlog is preserved.
 */
export const drainWorkflowQueueForThread$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);

    for (let attempt = 0; attempt < MAX_DRAIN_ATTEMPTS; attempt++) {
      const event = await claimNextWorkflowQueueEvent(db, args.chatThreadId);
      signal.throwIfAborted();
      if (!event) {
        return;
      }

      const target = await loadDequeueTarget(db, event);
      signal.throwIfAborted();
      if (!target) {
        log.debug("Dropping workflow queue event without automation", {
          eventId: event.id,
          automationId: event.automationId,
        });
        await publishChatThreadWorkflowQueueChangedSafely(
          event.userId,
          event.chatThreadId,
        );
        signal.throwIfAborted();
        continue;
      }

      const params = await decryptWorkflowQueueEventParams(
        event.encryptedParams,
        { userId: event.userId, orgId: event.orgId },
      );
      signal.throwIfAborted();
      if (!params) {
        log.error("Dropping undecryptable workflow queue event", {
          eventId: event.id,
          automationId: event.automationId,
        });
        continue;
      }

      const triggerSource = triggerSourceSchema.safeParse(event.triggerSource);
      const result = await set(
        runWorkflowAutomationNow$,
        {
          due: {
            automation: target.automation,
            agentId: target.agentId,
            workflowName: target.workflowName,
            chatThreadId: event.chatThreadId,
          },
          apiStartTime: event.apiStartedAt?.getTime() ?? now(),
          firstAssistantTimingStartedAt: event.apiStartedAt,
          prompt: params.prompt,
          triggerBrief: event.triggerBrief ?? undefined,
          triggerSource: triggerSource.success ? triggerSource.data : undefined,
          appendSystemPrompt: params.appendSystemPrompt,
          callbacks: params.callbacks,
          activePreviousRunPolicy: "allow",
          recordLastRunId: params.recordLastRunId,
          recordLastRunAt: params.recordLastRunAt,
          bypassWorkflowQueue: true,
          dispatchFailedCallbacks: args.dispatchFailedCallbacks,
        },
        signal,
      );
      signal.throwIfAborted();

      if (result.kind === "ok" || result.kind === "enqueued") {
        await publishChatThreadWorkflowQueueChangedSafely(
          event.userId,
          event.chatThreadId,
        );
        signal.throwIfAborted();
        return;
      }
      if (result.kind === "conflict") {
        log.debug("Skipping unfireable workflow queue event", {
          eventId: event.id,
          automationId: event.automationId,
          message: result.message,
        });
        continue;
      }

      await restoreWorkflowQueueEventAndPause(db, {
        event,
        pauseReason: result.response.body.error.message,
        pausedAt: nowDate(),
      });
      signal.throwIfAborted();
      log.warn("Workflow queue paused after run creation failure", {
        eventId: event.id,
        chatThreadId: event.chatThreadId,
        code: result.response.body.error.code,
      });
      await publishChatThreadWorkflowQueueChangedSafely(
        event.userId,
        event.chatThreadId,
      );
      signal.throwIfAborted();
      return;
    }
  },
);
