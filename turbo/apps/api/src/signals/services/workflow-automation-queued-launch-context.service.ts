import {
  EVENT_POLICY,
  restoredWorkflowAutomationEventPayload,
  storedWorkflowAutomationContext,
  workflowAutomationAppendSystemPrompt,
  workflowAutomationEventTypeSchema,
  workflowAutomationPrompt,
  type WorkflowAutomationEventPayload,
} from "./workflow-automation-context.service";
import {
  buildChatOnlyWorkflowAutomationCallbacks,
  buildWorkflowAutomationCallbacks,
  type AutomationRow,
  type RunWorkflowAutomationNowArgs,
} from "./zero-workflow-automation-launch.service";

export interface WorkflowAutomationQueuedLaunchMaterial {
  readonly workflowName: string;
  readonly prompt?: string;
  readonly appendSystemPrompt?: string;
  readonly callbacks?: RunWorkflowAutomationNowArgs["callbacks"];
  readonly activePreviousRunPolicy?: RunWorkflowAutomationNowArgs["activePreviousRunPolicy"];
  readonly recordLastRunId?: boolean;
  readonly recordLastRunAt?: boolean;
  readonly allowClaimedOnceScheduleAutomation?: boolean;
}

export function buildWorkflowAutomationQueuedLaunchMaterial(args: {
  readonly workflowName: string | null;
  readonly eventType: string | null;
  readonly eventPayload: WorkflowAutomationEventPayload | null;
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly chatThreadId: string;
}): WorkflowAutomationQueuedLaunchMaterial | null {
  if (
    args.workflowName === null ||
    args.eventType === null ||
    args.eventPayload === null
  ) {
    return null;
  }
  const eventType = workflowAutomationEventTypeSchema.parse(args.eventType);
  const eventPayload = restoredWorkflowAutomationEventPayload(
    args.eventPayload,
  );
  if (!eventPayload) {
    return null;
  }
  const context = storedWorkflowAutomationContext({
    workflowName: args.workflowName,
    eventType,
    eventPayload,
  });
  return {
    workflowName: args.workflowName,
    prompt: workflowAutomationPrompt(context),
    appendSystemPrompt: workflowAutomationAppendSystemPrompt(context),
    callbacks:
      eventType === "schedule"
        ? buildWorkflowAutomationCallbacks(
            args.automation,
            args.agentId,
            args.chatThreadId,
          )
        : buildChatOnlyWorkflowAutomationCallbacks(
            args.chatThreadId,
            args.agentId,
          ),
    ...EVENT_POLICY[eventType],
    allowClaimedOnceScheduleAutomation: args.automation.scheduleType === "once",
  };
}
