import { agentRuns } from "@okouai/db/schema/agent-run";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "../lib/db";
import { admitWorkflowAutomationEvent } from "../signals/services/workflow-chat-event-queue.service";
import {
  persistedWorkflowAutomationEventPayload,
  storedWorkflowAutomationContext,
  workflowAutomationDisplayMessage,
} from "../signals/services/workflow-automation-context.service";

interface WorkflowAutomationEventFixtureArgs {
  readonly automationId: string;
  readonly chatThreadId: string;
  readonly triggerBrief: string;
}

export async function readWorkflowRunTriggerSourceFixture(
  runId: string,
): Promise<string | null> {
  const [run] = await db()
    .select({ triggerSource: agentRuns.triggerSource })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return run?.triggerSource ?? null;
}

/** Admit a complete generic-webhook context through the production queue path. */
export async function admitWorkflowAutomationEventFixture(
  args: WorkflowAutomationEventFixtureArgs,
): Promise<string> {
  const [row] = await db()
    .select({
      automation: workflowAutomations,
      workflowName: workflows.name,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
    .where(eq(workflowAutomations.id, args.automationId))
    .limit(1);
  if (!row) {
    throw new Error("Expected the workflow automation to exist");
  }
  const eventPayload = {
    receivedAt: "2026-08-01T12:00:00.000Z",
    deliveryId: args.triggerBrief,
  } as const;
  const automationContext = storedWorkflowAutomationContext({
    workflowName: row.workflowName,
    eventType: "webhook-received",
    eventPayload,
  });

  const admission = await admitWorkflowAutomationEvent(db(), {
    automation: row.automation,
    workflowName: row.workflowName,
    displayPrompt: workflowAutomationDisplayMessage(automationContext),
    workflowAutomationEventType: "webhook-received",
    workflowAutomationEventPayload:
      persistedWorkflowAutomationEventPayload(eventPayload),
    chatThreadId: args.chatThreadId,
    triggerSource: "automation-event",
    triggerBrief: args.triggerBrief,
    coalescePendingScheduleRun: false,
  });
  if (admission.kind !== "inserted") {
    throw new Error(
      `Expected the workflow automation event to be inserted, got ${admission.kind}`,
    );
  }
  return admission.eventId;
}
