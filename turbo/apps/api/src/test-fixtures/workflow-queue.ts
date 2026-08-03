import {
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { admitWorkflowAutomationEvent } from "../signals/services/workflow-chat-event-queue.service";
import { persistedWorkflowAutomationEventPayload } from "../signals/services/workflow-automation-context.service";

interface WorkflowAutomationEventFixtureArgs {
  readonly automationId: string;
  readonly chatThreadId: string;
  readonly triggerBrief: string;
}

/** Admit a complete generic-webhook context through the production queue path. */
export async function admitWorkflowAutomationEventFixture(
  args: WorkflowAutomationEventFixtureArgs,
): Promise<string> {
  const [row] = await db()
    .select({
      automation: zeroWorkflowAutomations,
      workflowName: zeroWorkflows.name,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .where(eq(zeroWorkflowAutomations.id, args.automationId))
    .limit(1);
  if (!row) {
    throw new Error("Expected the workflow automation to exist");
  }

  const admission = await admitWorkflowAutomationEvent(db(), {
    automation: row.automation,
    workflowName: row.workflowName,
    workflowAutomationEventType: "webhook-received",
    workflowAutomationEventPayload: persistedWorkflowAutomationEventPayload({
      receivedAt: "2026-08-01T12:00:00.000Z",
      deliveryId: args.triggerBrief,
    }),
    chatThreadId: args.chatThreadId,
    triggerSource: "workflow-event",
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
