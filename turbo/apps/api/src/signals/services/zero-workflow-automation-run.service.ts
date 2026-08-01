import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import {
  admitWorkflowAutomationEvent,
  type WorkflowQueueEventParams,
} from "./workflow-chat-event-queue.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import type {
  RunWorkflowAutomationNowArgs,
  RunWorkflowAutomationResult,
} from "./zero-workflow-automation-launch.service";

export {
  buildChatOnlyWorkflowAutomationCallbacks,
  scheduleTriggerContext,
  type AutomationRow,
  type DueWorkflowAutomation,
  type RunFailure,
  type RunWorkflowAutomationNowArgs,
  type RunWorkflowAutomationResult,
} from "./zero-workflow-automation-launch.service";

function queueEventParams(): WorkflowQueueEventParams {
  // Keep only the wire-version marker until the encrypted-params fallback is
  // removed after historical pending automation events have drained.
  return {
    version: 1,
  };
}

/**
 * Durable workflow-event ingress. Every event enters the chat thread queue
 * before the shared scheduler prepares a run; the run persistence transaction
 * later owns the authoritative queue claim.
 */
export const runWorkflowAutomationNow$ = command(
  async (
    { set },
    args: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const db = set(writeDb$);
    const { automation, chatThreadId } = args.due;
    const timing = args.timing ?? new ApiDispatchTimingCollector();
    if (!args.timing) {
      timing.recordElapsed(
        "api_dispatch_pre_create_zero_workflow_automation_entrypoint_gap",
        "nested",
        args.apiStartTime,
      );
    }

    const admission = await measureApiDispatchTiming(
      timing,
      "api_dispatch_pre_create_zero_workflow_automation_queue_admission",
      "nested",
      async () => {
        return await admitWorkflowAutomationEvent(db, {
          automation,
          workflowName: args.automationContext.workflowName,
          workflowAutomationEventType: args.automationContext.eventType,
          workflowAutomationEventPayload: args.automationContext.event,
          chatThreadId,
          triggerSource: args.triggerSource ?? "workflow-schedule",
          triggerBrief: args.triggerBrief,
          coalescePendingScheduleRun: args.coalescePendingScheduleRun !== false,
          params: queueEventParams(),
          persistSourceTransition: args.persistSourceTransition,
        });
      },
    );
    signal.throwIfAborted();

    if (admission.kind === "inserted") {
      await publishChatThreadMessageCreatedSafely(
        automation.ownerUserId,
        chatThreadId,
      );
      signal.throwIfAborted();
    }

    const drained = await set(
      drainChatThreadQueueForThread$,
      {
        chatThreadId,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
        ...(admission.kind === "inserted"
          ? {
              workflowEventLaunch: {
                eventId: admission.eventId,
                apiStartTime: args.apiStartTime,
                timing,
              },
            }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (
      admission.kind === "inserted" &&
      drained?.eventId === admission.eventId
    ) {
      return drained.result;
    }
    return { kind: "enqueued" };
  },
);
