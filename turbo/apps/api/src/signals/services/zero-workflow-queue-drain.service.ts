import {
  zeroWorkflows,
  zeroWorkflowAutomations,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { writeDb$, type Db } from "../external/db";
import { now } from "../external/time";
import {
  decryptWorkflowQueueEventParams,
  loadNextWorkflowQueueEvent,
  rejectWorkflowQueueEvent,
  type PendingWorkflowQueueEvent,
} from "./chat-message-queue.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  launchQueuedWorkflowAutomation$,
  type RunWorkflowAutomationResult,
} from "./zero-workflow-automation-launch.service";

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
  event: PendingWorkflowQueueEvent,
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
    .where(eq(zeroWorkflowAutomations.id, event.automationId))
    .limit(1);
  return row ?? null;
}

/**
 * Advance the thread's workflow queue: as long as user queued messages always
 * win (enforced inside `loadNextWorkflowQueueEvent`), prepare the oldest event
 * and turn it into a run. The final run persistence transaction consumes the
 * event. Stale events and failed run creations reject only their own trigger.
 */
export interface WorkflowQueueDrainResult {
  readonly eventId: string;
  readonly result: RunWorkflowAutomationResult;
}

interface WorkflowEventLaunch {
  readonly eventId: string;
  readonly apiStartTime: number;
  readonly timing: ApiDispatchTimingCollector;
}

interface DrainWorkflowQueueArgs {
  readonly chatThreadId: string;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly queueItemCreatedBefore?: Date;
  readonly workflowEventLaunch?: WorkflowEventLaunch;
}

const CONTINUE_DRAIN = Symbol("continue-workflow-queue-drain");
type WorkflowQueueDrainStep =
  | WorkflowQueueDrainResult
  | null
  | typeof CONTINUE_DRAIN;

async function publishQueueEventChanged(
  event: PendingWorkflowQueueEvent,
  signal: AbortSignal,
): Promise<void> {
  await publishChatThreadMessageCreatedSafely(event.userId, event.chatThreadId);
  signal.throwIfAborted();
}

async function consumeInvalidWorkflowEvent(
  db: Db,
  event: PendingWorkflowQueueEvent,
  conflictMessage: string,
  launchHint: WorkflowEventLaunch | undefined,
  signal: AbortSignal,
): Promise<WorkflowQueueDrainStep> {
  const consumed = await rejectWorkflowQueueEvent(db, {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    reason: conflictMessage,
  });
  signal.throwIfAborted();
  if (!consumed) {
    return null;
  }
  await publishQueueEventChanged(event, signal);
  if (launchHint?.eventId !== event.id) {
    return CONTINUE_DRAIN;
  }
  return {
    eventId: event.id,
    result: { kind: "conflict", message: conflictMessage },
  };
}

async function handleWorkflowLaunchResult(
  db: Db,
  event: PendingWorkflowQueueEvent,
  result: RunWorkflowAutomationResult,
  launchHint: WorkflowEventLaunch | undefined,
  signal: AbortSignal,
): Promise<WorkflowQueueDrainStep> {
  if (result.kind === "ok" || result.kind === "enqueued") {
    await publishQueueEventChanged(event, signal);
    return { eventId: event.id, result };
  }
  if (result.kind === "conflict") {
    log.debug("Consuming unfireable workflow queue event", {
      eventId: event.id,
      automationId: event.automationId,
      message: result.message,
    });
    const consumed = await rejectWorkflowQueueEvent(db, {
      eventId: event.id,
      chatThreadId: event.chatThreadId,
      reason: result.message,
    });
    signal.throwIfAborted();
    if (!consumed) {
      return null;
    }
    await publishQueueEventChanged(event, signal);
    return launchHint ? { eventId: event.id, result } : CONTINUE_DRAIN;
  }

  const failed = await rejectWorkflowQueueEvent(db, {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    reason: result.response.body.error.message,
  });
  signal.throwIfAborted();
  if (!failed) {
    return null;
  }
  log.warn("Workflow queue event rejected after run creation failure", {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    code: result.response.body.error.code,
  });
  await publishQueueEventChanged(event, signal);
  return {
    eventId: event.id,
    result,
  };
}

export const drainWorkflowQueueForThread$ = command(
  async (
    { set },
    args: DrainWorkflowQueueArgs,
    signal: AbortSignal,
  ): Promise<WorkflowQueueDrainResult | null> => {
    const db = set(writeDb$);

    for (let attempt = 0; attempt < MAX_DRAIN_ATTEMPTS; attempt++) {
      const event = await loadNextWorkflowQueueEvent(
        db,
        args.chatThreadId,
        args.queueItemCreatedBefore,
      );
      signal.throwIfAborted();
      if (!event) {
        return null;
      }

      const target = await loadDequeueTarget(db, event);
      signal.throwIfAborted();
      if (!target) {
        log.debug("Consuming workflow queue event without automation", {
          eventId: event.id,
          automationId: event.automationId,
        });
        const step = await consumeInvalidWorkflowEvent(
          db,
          event,
          "Workflow automation no longer exists",
          args.workflowEventLaunch,
          signal,
        );
        if (step !== CONTINUE_DRAIN) {
          return step;
        }
        continue;
      }

      const params = await decryptWorkflowQueueEventParams(
        event.encryptedParams,
        {
          userId: target.automation.ownerUserId,
          orgId: target.automation.orgId,
        },
      );
      signal.throwIfAborted();
      if (!params) {
        log.error("Consuming undecryptable workflow queue event", {
          eventId: event.id,
          automationId: event.automationId,
        });
        const step = await consumeInvalidWorkflowEvent(
          db,
          event,
          "Workflow queue event payload is unreadable",
          args.workflowEventLaunch,
          signal,
        );
        if (step !== CONTINUE_DRAIN) {
          return step;
        }
        continue;
      }

      const launchHint =
        args.workflowEventLaunch?.eventId === event.id
          ? args.workflowEventLaunch
          : undefined;
      const result = await set(
        launchQueuedWorkflowAutomation$,
        {
          due: {
            automation: target.automation,
            agentId: target.agentId,
            workflowName: target.workflowName,
            chatThreadId: event.chatThreadId,
            allowClaimedOnceScheduleAutomation:
              params.allowClaimedOnceScheduleAutomation,
          },
          queueEventId: event.id,
          apiStartTime: launchHint?.apiStartTime ?? now(),
          prompt: params.prompt,
          triggerBrief: event.triggerBrief ?? undefined,
          triggerSource: event.triggerSource,
          appendSystemPrompt: params.appendSystemPrompt,
          callbacks: params.callbacks,
          activePreviousRunPolicy: params.activePreviousRunPolicy,
          recordLastRunId: params.recordLastRunId,
          recordLastRunAt: params.recordLastRunAt,
          dispatchFailedCallbacks: args.dispatchFailedCallbacks,
          timing: launchHint?.timing,
        },
        signal,
      );
      signal.throwIfAborted();

      const step = await handleWorkflowLaunchResult(
        db,
        event,
        result,
        launchHint,
        signal,
      );
      if (step !== CONTINUE_DRAIN) {
        return step;
      }
    }
    return null;
  },
);
