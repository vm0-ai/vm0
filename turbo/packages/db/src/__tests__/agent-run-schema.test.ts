import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

function foreignKeyReference(
  table: Parameters<typeof getTableConfig>[0],
  columnName: string,
) {
  const foreignKey = getTableConfig(table).foreignKeys.find((candidate) => {
    return candidate.reference().columns.some((column) => {
      return column.name === columnName;
    });
  });
  expect(foreignKey).toBeDefined();
  if (!foreignKey) {
    throw new Error(`Missing foreign key for ${columnName}`);
  }
  return { foreignKey, reference: foreignKey.reference() };
}

describe("agentRuns circular foreign keys", () => {
  it("resolves both agent_runs and chat_threads references from the root schema", async () => {
    const referenceRegistry = await import("../schema/agent-run-reference");
    expect(() => {
      return referenceRegistry.resolveAgentRunId();
    }).toThrow(
      "Agent-run schema references were resolved before schema initialization",
    );

    const { schema } = await import("../index");
    const { agentRuns } =
      await import("../schema/agent-run-session-conversation");
    const { chatThreads } = await import("../schema/chat-thread");
    const { threadGoals } = await import("../schema/thread-goal");
    const { workflowAutomations } = await import("../schema/workflow");

    expect(schema.agentRuns).toBe(agentRuns);
    expect(schema.chatThreads).toBe(chatThreads);

    const chatThread = foreignKeyReference(agentRuns, "chat_thread_id");
    expect(chatThread.foreignKey.getName()).toBe(
      "agent_runs_chat_thread_id_chat_threads_id_fk",
    );
    expect(chatThread.foreignKey.onDelete).toBe("set null");
    expect(chatThread.reference.columns).toEqual([agentRuns.chatThreadId]);
    expect(chatThread.reference.foreignTable).toBe(chatThreads);
    expect(chatThread.reference.foreignColumns).toEqual([chatThreads.id]);

    const workflowAutomation = foreignKeyReference(
      agentRuns,
      "workflow_automation_id",
    );
    expect(workflowAutomation.foreignKey.getName()).toBe(
      "agent_runs_workflow_automation_id_zero_workflow_automations_id_fk",
    );
    expect(workflowAutomation.foreignKey.onDelete).toBe("set null");
    expect(workflowAutomation.reference.columns).toEqual([
      agentRuns.workflowAutomationId,
    ]);
    expect(workflowAutomation.reference.foreignTable).toBe(workflowAutomations);
    expect(workflowAutomation.reference.foreignColumns).toEqual([
      workflowAutomations.id,
    ]);

    const goal = foreignKeyReference(agentRuns, "goal_id");
    expect(goal.foreignKey.getName()).toBe(
      "agent_runs_goal_id_thread_goals_id_fk",
    );
    expect(goal.foreignKey.onDelete).toBe("set null");
    expect(goal.reference.columns).toEqual([agentRuns.goalId]);
    expect(goal.reference.foreignTable).toBe(threadGoals);
    expect(goal.reference.foreignColumns).toEqual([threadGoals.id]);

    const agentSessionRun = foreignKeyReference(
      chatThreads,
      "agent_session_run_id",
    );
    expect(agentSessionRun.foreignKey.getName()).toBe(
      "chat_threads_agent_session_run_id_agent_runs_id_fk",
    );
    expect(agentSessionRun.foreignKey.onDelete).toBe("set null");
    expect(agentSessionRun.reference.columns).toEqual([
      chatThreads.agentSessionRunId,
    ]);
    expect(agentSessionRun.reference.foreignTable).toBe(agentRuns);
    expect(agentSessionRun.reference.foreignColumns).toEqual([agentRuns.id]);
  });
});
