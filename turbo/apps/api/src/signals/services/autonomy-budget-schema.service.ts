import { threadGoals } from "@okouai/db/schema/thread-goal";
import { zeroWorkflowAutomations } from "@okouai/db/schema/zero-workflow";

import type { Db } from "../external/db";

export function threadGoalColumns() {
  return {
    id: threadGoals.id,
    orgId: threadGoals.orgId,
    ownerUserId: threadGoals.ownerUserId,
    agentId: threadGoals.agentId,
    chatThreadId: threadGoals.chatThreadId,
    status: threadGoals.status,
    objective: threadGoals.objective,
    objectiveBrief: threadGoals.objectiveBrief,
    autonomyBudget: threadGoals.autonomyBudget,
    createdAt: threadGoals.createdAt,
    updatedAt: threadGoals.updatedAt,
  };
}

export function workflowAutomationColumns() {
  return {
    id: zeroWorkflowAutomations.id,
    orgId: zeroWorkflowAutomations.orgId,
    workflowId: zeroWorkflowAutomations.workflowId,
    ownerUserId: zeroWorkflowAutomations.ownerUserId,
    kind: zeroWorkflowAutomations.kind,
    eventType: zeroWorkflowAutomations.eventType,
    eventConfig: zeroWorkflowAutomations.eventConfig,
    scheduleType: zeroWorkflowAutomations.scheduleType,
    cronExpression: zeroWorkflowAutomations.cronExpression,
    intervalSeconds: zeroWorkflowAutomations.intervalSeconds,
    atTime: zeroWorkflowAutomations.atTime,
    timezone: zeroWorkflowAutomations.timezone,
    enabled: zeroWorkflowAutomations.enabled,
    nextRunAt: zeroWorkflowAutomations.nextRunAt,
    lastRunAt: zeroWorkflowAutomations.lastRunAt,
    lastRunId: zeroWorkflowAutomations.lastRunId,
    consecutiveFailures: zeroWorkflowAutomations.consecutiveFailures,
    autonomyBudget: zeroWorkflowAutomations.autonomyBudget,
    createdAt: zeroWorkflowAutomations.createdAt,
    updatedAt: zeroWorkflowAutomations.updatedAt,
  };
}

export async function insertWorkflowAutomation(
  db: Db,
  values: typeof zeroWorkflowAutomations.$inferInsert,
): Promise<typeof zeroWorkflowAutomations.$inferSelect | undefined> {
  const [row] = await db
    .insert(zeroWorkflowAutomations)
    .values(values)
    .returning(workflowAutomationColumns());
  return row;
}
