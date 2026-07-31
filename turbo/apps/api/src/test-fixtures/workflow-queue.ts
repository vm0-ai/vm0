import { randomBytes } from "node:crypto";

import {
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { admitWorkflowAutomationEvent } from "../signals/services/workflow-chat-event-queue.service";

interface PreviousDeploymentWorkflowEventArgs {
  readonly automationId: string;
  readonly chatThreadId: string;
  readonly agentId: string;
  readonly appendSystemPrompt: string;
  readonly triggerBrief?: string;
}

/**
 * Admit an event through the production admission service using the queue
 * payload shape written before automations started carrying a trigger line:
 * `appendSystemPrompt` only, with no `prompt`.
 *
 * Current production code always writes both, so no external endpoint can
 * construct this row, but rows in this shape can still be drained by the new
 * backend during a rollout. Everything except the payload shape stays on the
 * real path, including encryption and the admission transaction.
 */
export async function admitPreviousDeploymentWorkflowEventFixture(
  args: PreviousDeploymentWorkflowEventArgs,
): Promise<void> {
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
    chatThreadId: args.chatThreadId,
    triggerSource: "workflow-event",
    triggerBrief: args.triggerBrief,
    coalescePendingScheduleRun: false,
    params: {
      version: 1,
      appendSystemPrompt: args.appendSystemPrompt,
      callbacks: [
        {
          internalKind: "chat",
          secret: randomBytes(32).toString("hex"),
          payload: { threadId: args.chatThreadId, agentId: args.agentId },
        },
      ],
      recordLastRunId: false,
      recordLastRunAt: true,
      activePreviousRunPolicy: "allow",
    },
  });
  if (admission.kind !== "inserted") {
    throw new Error(
      `Expected the previous-deployment event to be inserted, got ${admission.kind}`,
    );
  }
}
