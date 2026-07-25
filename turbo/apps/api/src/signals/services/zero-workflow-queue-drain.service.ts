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
  consumeWorkflowQueueEvent,
  decryptWorkflowQueueEventParams,
  loadNextWorkflowQueueEvent,
  pauseWorkflowQueueEventAfterRunFailure,
  type PendingWorkflowQueueEvent,
  type WorkflowQueueEventParams,
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
 * win (enforced inside `loadNextWorkflowQueueEvent`), prepare the oldest event
 * and turn it into a run. The final run persistence transaction consumes the
 * event. Stale events are serialized and removed; a run-creation failure
 * leaves the event in place and pauses the queue.
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
  readonly workflowEventLaunch?: WorkflowEventLaunch;
}

function allowClaimedOnceScheduleAutomation(
  target: DequeueTarget,
  params: WorkflowQueueEventParams,
): boolean | undefined {
  if (params.allowClaimedOnceScheduleAutomation !== undefined) {
    return params.allowClaimedOnceScheduleAutomation;
  }

  const automation = target.automation;
  if (
    automation.kind === "schedule" &&
    automation.scheduleType === "once" &&
    !automation.enabled &&
    automation.nextRunAt === null &&
    automation.lastRunAt !== null
  ) {
    // Previous writers disabled a claimed one-time automation before inserting
    // its v1 queue payload, which did not carry the explicit claim marker.
    return true;
  }
  return undefined;
}

const CONTINUE_DRAIN = Symbol("continue-workflow-queue-drain");
type WorkflowQueueDrainStep =
  | WorkflowQueueDrainResult
  | null
  | typeof CONTINUE_DRAIN;

async function publishQueueChanged(
  event: PendingWorkflowQueueEvent,
  signal: AbortSignal,
): Promise<void> {
  await publishChatThreadWorkflowQueueChangedSafely(
    event.userId,
    event.chatThreadId,
  );
  signal.throwIfAborted();
}

async function consumeInvalidWorkflowEvent(
  db: Db,
  event: PendingWorkflowQueueEvent,
  conflictMessage: string,
  launchHint: WorkflowEventLaunch | undefined,
  signal: AbortSignal,
): Promise<WorkflowQueueDrainStep> {
  const consumed = await consumeWorkflowQueueEvent(db, {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
  });
  signal.throwIfAborted();
  if (!consumed) {
    return null;
  }
  await publishQueueChanged(event, signal);
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
    await publishQueueChanged(event, signal);
    return { eventId: event.id, result };
  }
  if (result.kind === "conflict") {
    log.debug("Consuming unfireable workflow queue event", {
      eventId: event.id,
      automationId: event.automationId,
      message: result.message,
    });
    const consumed = await consumeWorkflowQueueEvent(db, {
      eventId: event.id,
      chatThreadId: event.chatThreadId,
    });
    signal.throwIfAborted();
    if (!consumed) {
      return null;
    }
    await publishQueueChanged(event, signal);
    return launchHint ? { eventId: event.id, result } : CONTINUE_DRAIN;
  }

  await pauseWorkflowQueueEventAfterRunFailure(db, {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    pauseReason: result.response.body.error.message,
    pausedAt: nowDate(),
  });
  signal.throwIfAborted();
  log.warn("Workflow queue paused after run creation failure", {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    code: result.response.body.error.code,
  });
  await publishQueueChanged(event, signal);
  return {
    eventId: event.id,
    // The failed launch did not consume the durable event. Report accepted
    // ownership so ingress callers do not retry or reschedule a retained event.
    result: { kind: "enqueued" },
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
      const event = await loadNextWorkflowQueueEvent(db, args.chatThreadId);
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
        { userId: event.userId, orgId: event.orgId },
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

      const triggerSource = triggerSourceSchema.safeParse(event.triggerSource);
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
              allowClaimedOnceScheduleAutomation(target, params),
          },
          queueEventId: event.id,
          apiStartTime: launchHint?.apiStartTime ?? now(),
          sessionId: params.sessionId,
          prompt: params.prompt,
          triggerBrief: event.triggerBrief ?? undefined,
          triggerSource: triggerSource.success ? triggerSource.data : undefined,
          appendSystemPrompt: params.appendSystemPrompt,
          callbacks: params.callbacks,
          // Rows written before queue-first ingress always dequeued with
          // "allow"; new rows persist their caller policy explicitly.
          activePreviousRunPolicy: params.activePreviousRunPolicy ?? "allow",
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
