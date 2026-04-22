import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { seedTestCompose } from "../../../../__tests__/db-test-seeders/agents";
import { seedTestRun } from "../../../../__tests__/db-test-seeders/runs";
/* eslint-disable web/no-direct-db-in-tests -- Service-level exception: no route covers task-service yet */
import {
  voiceChatEvents,
  voiceChatSessions,
  voiceChatTasks,
} from "../../../../db/schema/voice-chat";
import { agentRuns } from "../../../../db/schema/agent-run";
import {
  appendTaskEvent,
  attachTaskRun,
  cancelSessionPendingRuns,
  completeVoiceChatTask,
  createVoiceChatTask,
  getVoiceChatTask,
  listVoiceChatTasks,
} from "../task-service";

const context = testContext();

async function seedActiveSession(): Promise<{
  userId: string;
  orgId: string;
  agentId: string;
  sessionId: string;
}> {
  const { userId, orgId } = await context.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("voice-chat-task-compose"),
  });

  const [session] = await globalThis.services.db
    .insert(voiceChatSessions)
    .values({
      orgId,
      userId,
      agentId: composeId,
      status: "active",
    })
    .returning();

  return { userId, orgId, agentId: composeId, sessionId: session!.id };
}

describe("createVoiceChatTask", () => {
  it("inserts a row with status=pending and runId=NULL", async () => {
    context.setupMocks();
    const { sessionId } = await seedActiveSession();

    const task = await createVoiceChatTask({
      sessionId,
      prompt: "do a thing",
    });

    expect(task.status).toBe("pending");
    expect(task.runId).toBeNull();
    expect(task.result).toBeNull();
    expect(task.error).toBeNull();
    expect(task.assistantMessages).toEqual([]);
    expect(task.finishedAt).toBeNull();
  });
});

describe("attachTaskRun", () => {
  it("sets runId and flips status to queued", async () => {
    context.setupMocks();
    const { userId, agentId, sessionId } = await seedActiveSession();
    const task = await createVoiceChatTask({ sessionId, prompt: "attach" });
    const { runId } = await seedTestRun(userId, agentId, {
      status: "queued",
      triggerSource: "voice-chat",
    });

    const attached = await attachTaskRun({ taskId: task.id, runId });

    expect(attached).not.toBeNull();
    expect(attached!.runId).toBe(runId);
    expect(attached!.status).toBe("queued");
  });
});

describe("completeVoiceChatTask", () => {
  it("marks done with result on successful completion", async () => {
    context.setupMocks();
    const { sessionId } = await seedActiveSession();
    const task = await createVoiceChatTask({ sessionId, prompt: "done" });

    const completed = await completeVoiceChatTask({
      taskId: task.id,
      status: "done",
      result: "hello world",
      error: null,
    });

    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("done");
    expect(completed!.result).toBe("hello world");
    expect(completed!.error).toBeNull();
    expect(completed!.finishedAt).not.toBeNull();
  });

  it("marks failed with error text on failure", async () => {
    context.setupMocks();
    const { sessionId } = await seedActiveSession();
    const task = await createVoiceChatTask({ sessionId, prompt: "fail" });

    const completed = await completeVoiceChatTask({
      taskId: task.id,
      status: "failed",
      result: null,
      error: "boom",
    });

    expect(completed!.status).toBe("failed");
    expect(completed!.error).toBe("boom");
  });

  it("returns null for unknown taskId", async () => {
    context.setupMocks();
    const result = await completeVoiceChatTask({
      taskId: "00000000-0000-0000-0000-000000000000",
      status: "done",
      result: null,
      error: null,
    });
    expect(result).toBeNull();
  });
});

describe("getVoiceChatTask / listVoiceChatTasks", () => {
  it("returns tasks scoped to their session, ordered by createdAt ASC", async () => {
    context.setupMocks();
    const { sessionId } = await seedActiveSession();
    const { sessionId: otherSessionId } = await seedActiveSession();

    const first = await createVoiceChatTask({ sessionId, prompt: "first" });
    const second = await createVoiceChatTask({ sessionId, prompt: "second" });
    await createVoiceChatTask({ sessionId: otherSessionId, prompt: "other" });

    const list = await listVoiceChatTasks(sessionId);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(first.id);
    expect(list[1]!.id).toBe(second.id);

    const fetched = await getVoiceChatTask(first.id);
    expect(fetched!.id).toBe(first.id);
  });
});

describe("appendTaskEvent", () => {
  it("inserts a system-source event that bypasses the active-session gate", async () => {
    context.setupMocks();
    const { sessionId } = await seedActiveSession();

    await globalThis.services.db
      .update(voiceChatSessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(voiceChatSessions.id, sessionId));

    await appendTaskEvent(sessionId, "task-completed", "task-abc");

    const rows = await globalThis.services.db
      .select()
      .from(voiceChatEvents)
      .where(eq(voiceChatEvents.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("system");
    expect(rows[0]!.type).toBe("task-completed");
    expect(rows[0]!.content).toBe(JSON.stringify({ taskId: "task-abc" }));
  });
});

describe("cancelSessionPendingRuns", () => {
  it("cancels the backing runs and marks in-flight tasks failed", async () => {
    context.setupMocks();
    const { userId, orgId, agentId, sessionId } = await seedActiveSession();

    // Pending task without a run — cancelRun is skipped.
    const pendingNoRun = await createVoiceChatTask({
      sessionId,
      prompt: "pending-no-run",
    });

    // Queued task with a running backing agent_run.
    const queued = await createVoiceChatTask({ sessionId, prompt: "queued" });
    const { runId: queuedRunId } = await seedTestRun(userId, agentId, {
      orgId,
      status: "running",
      triggerSource: "voice-chat",
    });
    await attachTaskRun({ taskId: queued.id, runId: queuedRunId });

    // Already-done task must NOT be touched.
    const done = await createVoiceChatTask({ sessionId, prompt: "done" });
    await completeVoiceChatTask({
      taskId: done.id,
      status: "done",
      result: "ok",
      error: null,
    });

    await cancelSessionPendingRuns(sessionId);

    const tasks = await listVoiceChatTasks(sessionId);
    const byId = new Map(
      tasks.map((t) => {
        return [t.id, t] as const;
      }),
    );
    expect(byId.get(pendingNoRun.id)!.status).toBe("failed");
    expect(byId.get(pendingNoRun.id)!.error).toBe("session ended");
    expect(byId.get(queued.id)!.status).toBe("failed");
    expect(byId.get(queued.id)!.error).toBe("session ended");
    expect(byId.get(done.id)!.status).toBe("done");
    expect(byId.get(done.id)!.error).toBeNull();

    const [run] = await globalThis.services.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, queuedRunId));
    expect(run!.status).toBe("cancelled");
  });

  it("is a no-op when the session has no in-flight tasks", async () => {
    context.setupMocks();
    const { sessionId } = await seedActiveSession();

    const done = await createVoiceChatTask({ sessionId, prompt: "done" });
    await completeVoiceChatTask({
      taskId: done.id,
      status: "done",
      result: null,
      error: null,
    });

    await cancelSessionPendingRuns(sessionId);

    const [row] = await globalThis.services.db
      .select()
      .from(voiceChatTasks)
      .where(
        and(
          eq(voiceChatTasks.id, done.id),
          eq(voiceChatTasks.sessionId, sessionId),
        ),
      );
    expect(row!.status).toBe("done");
  });
});
/* eslint-enable web/no-direct-db-in-tests */
