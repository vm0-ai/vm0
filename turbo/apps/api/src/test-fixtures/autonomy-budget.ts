import { agentRuns } from "@vm0/db/schema/agent-run";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { zeroWorkflowAutomations } from "@vm0/db/schema/zero-workflow";
import { desc, eq } from "drizzle-orm";

import { db } from "../lib/db";

export async function readRunAutonomyBudgetFixture(
  runId: string,
): Promise<number | null> {
  const [run] = await db()
    .select({ autonomyBudget: zeroRuns.autonomyBudget })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return run?.autonomyBudget ?? null;
}

export async function setRunAutonomyBudgetFixture(
  runId: string,
  autonomyBudget: number,
): Promise<void> {
  const [run] = await db()
    .update(zeroRuns)
    .set({ autonomyBudget })
    .where(eq(zeroRuns.id, runId))
    .returning({ id: zeroRuns.id });
  if (!run) {
    throw new Error("Expected the autonomy-budget run fixture");
  }
}

export async function readWorkflowAutomationAutonomyFixture(
  automationId: string,
): Promise<{
  readonly autonomyBudget: number;
  readonly enabled: boolean;
  readonly lastRunId: string | null;
} | null> {
  const [automation] = await db()
    .select({
      autonomyBudget: zeroWorkflowAutomations.autonomyBudget,
      enabled: zeroWorkflowAutomations.enabled,
      lastRunId: zeroWorkflowAutomations.lastRunId,
    })
    .from(zeroWorkflowAutomations)
    .where(eq(zeroWorkflowAutomations.id, automationId))
    .limit(1);
  return automation ?? null;
}

export async function setWorkflowAutomationAutonomyBudgetFixture(
  automationId: string,
  autonomyBudget: number,
): Promise<void> {
  const [automation] = await db()
    .update(zeroWorkflowAutomations)
    .set({ autonomyBudget })
    .where(eq(zeroWorkflowAutomations.id, automationId))
    .returning({ id: zeroWorkflowAutomations.id });
  if (!automation) {
    throw new Error("Expected the autonomy-budget automation fixture");
  }
}

export async function readLatestWorkflowAutomationRunFixture(
  automationId: string,
): Promise<{
  readonly runId: string;
  readonly autonomyBudget: number;
} | null> {
  const [run] = await db()
    .select({
      runId: zeroRuns.id,
      autonomyBudget: zeroRuns.autonomyBudget,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(eq(zeroRuns.workflowAutomationId, automationId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run ?? null;
}

export async function readThreadGoalAutonomyBudgetFixture(
  threadId: string,
): Promise<number | null> {
  const [goal] = await db()
    .select({ autonomyBudget: threadGoals.autonomyBudget })
    .from(threadGoals)
    .where(eq(threadGoals.chatThreadId, threadId))
    .limit(1);
  return goal?.autonomyBudget ?? null;
}
