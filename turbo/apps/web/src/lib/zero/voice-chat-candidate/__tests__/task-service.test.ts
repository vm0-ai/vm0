import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { seedTestCompose } from "../../../../__tests__/db-test-seeders/agents";
import { seedTestRun } from "../../../../__tests__/db-test-seeders/runs";
import { initServices } from "../../../init-services";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import { createVoiceChatCandidateSession } from "../session-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import {
  createVoiceChatCandidateTask,
  completeVoiceChatCandidateTask,
  listPendingVoiceChatCandidateTasks,
  cancelSessionPendingRuns,
  type SpawnRun,
} from "../task-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify DB side-effects directly
import {
  featureCandidateVoiceChatSessions,
  featureCandidateVoiceChatTasks,
} from "../../../../db/schema/voice-chat-candidate";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify DB side-effects directly
import { agentRuns } from "../../../../db/schema/agent-run";

const context = testContext();

async function seedActiveSession() {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: test exercises services directly, no API route
  initServices();
  const { userId, orgId } = await context.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vcc-compose"),
  });
  const session = await createVoiceChatCandidateSession({
    orgId,
    userId,
    agentId: composeId,
  });
  return { userId, orgId, agentId: composeId, composeId, session };
}

describe("createVoiceChatCandidateTask", () => {
  it("inserts the task row before calling spawnRun and returns status=pending when spawn returns pending", async () => {
    context.setupMocks();
    const { session, userId, orgId, composeId } = await seedActiveSession();
    const { runId: spawnedRunId } = await seedTestRun(userId, composeId, {
      status: "pending",
      orgId,
    });

    const spawnRun: SpawnRun = async () => {
      // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify row ordering
      const db = globalThis.services.db;
      const pre = await db
        .select()
        .from(featureCandidateVoiceChatTasks)
        .where(eq(featureCandidateVoiceChatTasks.sessionId, session.id));
      expect(pre).toHaveLength(1);
      expect(pre[0]!.status).toBe("pending");
      expect(pre[0]!.runId).toBeNull();
      return {
        runId: spawnedRunId,
        status: "pending",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };

    const task = await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "call_pending",
      prompt: "do a thing",
      spawnRun,
    });

    expect(task.status).toBe("pending");
    expect(task.runId).toBe(spawnedRunId);
    expect(task.callId).toBe("call_pending");
    expect(task.prompt).toBe("do a thing");
  });

  it("sets task.status=queued when spawnRun returns queued", async () => {
    context.setupMocks();
    const { session, userId, orgId, composeId } = await seedActiveSession();
    const { runId } = await seedTestRun(userId, composeId, {
      status: "queued",
      orgId,
    });
    const spawnRun: SpawnRun = async () => {
      return {
        runId,
        status: "queued",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };

    const task = await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "call_queued",
      prompt: "queued",
      spawnRun,
    });

    expect(task.status).toBe("queued");
  });

  it("leaves task row as pending-with-null-runId if spawnRun throws", async () => {
    context.setupMocks();
    const { session } = await seedActiveSession();
    const spawnRun: SpawnRun = async () => {
      throw new Error("dispatcher down");
    };

    await expect(
      createVoiceChatCandidateTask({
        sessionId: session.id,
        callId: "call_fail_spawn",
        prompt: "fail",
        spawnRun,
      }),
    ).rejects.toThrow(/dispatcher down/);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify orphaned row
    const db = globalThis.services.db;
    const rows = await db
      .select()
      .from(featureCandidateVoiceChatTasks)
      .where(
        and(
          eq(featureCandidateVoiceChatTasks.sessionId, session.id),
          eq(featureCandidateVoiceChatTasks.callId, "call_fail_spawn"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.runId).toBeNull();
  });
});

describe("completeVoiceChatCandidateTask", () => {
  it("transitions to done and writes a task_result item on success", async () => {
    context.setupMocks();
    const { session, agentId, userId, orgId, composeId } =
      await seedActiveSession();
    const { runId } = await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
      orgId,
    });

    const spawnRun: SpawnRun = async () => {
      return {
        runId,
        status: "queued",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };
    const task = await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "c_done",
      prompt: "p",
      spawnRun,
    });

    const completed = await completeVoiceChatCandidateTask({
      taskId: task.id,
      result: "all good",
      error: null,
      agentId,
    });

    expect(completed.task.status).toBe("done");
    expect(completed.task.result).toBe("all good");
    expect(completed.task.finishedAt).not.toBeNull();
    expect(completed.item.role).toBe("task_result");
    expect(completed.item.taskId).toBe(task.id);
    expect(completed.item.content).toContain("all good");
  });

  it("transitions to failed and formats the error content when error is set", async () => {
    context.setupMocks();
    const { session, agentId, userId, orgId, composeId } =
      await seedActiveSession();
    const { runId } = await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
      orgId,
    });

    const spawnRun: SpawnRun = async () => {
      return {
        runId,
        status: "queued",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };
    const task = await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "c_fail",
      prompt: "p",
      spawnRun,
    });

    const completed = await completeVoiceChatCandidateTask({
      taskId: task.id,
      result: null,
      error: "worker timeout",
      agentId,
    });

    expect(completed.task.status).toBe("failed");
    expect(completed.task.error).toBe("worker timeout");
    expect(completed.item.content).toBe("[task failed] worker timeout");
  });

  it("ends the session and writes a system_note item on agent mismatch, and cancels other pending runs", async () => {
    context.setupMocks();
    const { session, userId, orgId, composeId } = await seedActiveSession();

    const { runId: completeRunId } = await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
      orgId,
    });
    const { runId: otherPendingRunId } = await seedTestRun(userId, composeId, {
      status: "pending",
      orgId,
    });

    const completeSpawn: SpawnRun = async () => {
      return {
        runId: completeRunId,
        status: "queued",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };
    const completeTask = await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "c_bad_agent",
      prompt: "p",
      spawnRun: completeSpawn,
    });

    const otherSpawn: SpawnRun = async () => {
      return {
        runId: otherPendingRunId,
        status: "pending",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };
    await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "c_sibling",
      prompt: "still pending",
      spawnRun: otherSpawn,
    });

    const wrongAgentId = randomUUID();
    const completed = await completeVoiceChatCandidateTask({
      taskId: completeTask.id,
      result: "should be ignored",
      error: null,
      agentId: wrongAgentId,
    });

    expect(completed.task.status).toBe("failed");
    expect(completed.task.error).toMatch(/agent mismatch/i);
    expect(completed.item.role).toBe("system_note");
    expect(completed.item.content).toMatch(/agent mismatch/i);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify teardown
    const db = globalThis.services.db;
    const [sessionRow] = await db
      .select()
      .from(featureCandidateVoiceChatSessions)
      .where(eq(featureCandidateVoiceChatSessions.id, session.id));
    expect(sessionRow!.status).toBe("ended");
    expect(sessionRow!.endedAt).not.toBeNull();

    const [otherRun] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, otherPendingRunId));
    expect(otherRun!.status).toBe("cancelled");
  });

  it("throws notFound when taskId does not exist", async () => {
    context.setupMocks();
    await expect(
      completeVoiceChatCandidateTask({
        taskId: randomUUID(),
        result: null,
        error: null,
        agentId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("listPendingVoiceChatCandidateTasks", () => {
  it("returns tasks in pending and queued status and excludes done/failed", async () => {
    context.setupMocks();
    const { session, agentId, userId, orgId, composeId } =
      await seedActiveSession();

    const { runId: pendingRunId } = await seedTestRun(userId, composeId, {
      status: "pending",
      orgId,
    });
    const spawnPending: SpawnRun = async () => {
      return {
        runId: pendingRunId,
        status: "pending",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };
    await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "list_pending",
      prompt: "p",
      spawnRun: spawnPending,
    });

    const { runId: queuedRunId } = await seedTestRun(userId, composeId, {
      status: "queued",
      orgId,
    });
    const spawnQueued: SpawnRun = async () => {
      return {
        runId: queuedRunId,
        status: "queued",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };
    await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "list_queued",
      prompt: "p",
      spawnRun: spawnQueued,
    });

    const { runId: doneRunId } = await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
      orgId,
    });
    const spawnDone: SpawnRun = async () => {
      return {
        runId: doneRunId,
        status: "queued",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };
    const doneTask = await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "list_done",
      prompt: "p",
      spawnRun: spawnDone,
    });
    await completeVoiceChatCandidateTask({
      taskId: doneTask.id,
      result: "ok",
      error: null,
      agentId,
    });

    const pending = await listPendingVoiceChatCandidateTasks(session.id);
    const callIds = pending
      .map((t) => {
        return t.callId;
      })
      .sort();
    expect(callIds).toEqual(["list_pending", "list_queued"]);
  });
});

describe("cancelSessionPendingRuns", () => {
  it("swallows cancelRun errors for terminal runs", async () => {
    context.setupMocks();
    const { session, userId, orgId, composeId } = await seedActiveSession();

    const { runId: terminalRunId } = await seedTestRun(userId, composeId, {
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      orgId,
    });
    const spawnTerminal: SpawnRun = async () => {
      return {
        runId: terminalRunId, // already terminal — cancelRun will throw runNotCancellable
        status: "queued",
        createdAt: new Date(),
        sessionId: session.id,
      };
    };
    await createVoiceChatCandidateTask({
      sessionId: session.id,
      callId: "cancel_swallow",
      prompt: "p",
      spawnRun: spawnTerminal,
    });

    await expect(
      cancelSessionPendingRuns({
        id: session.id,
        orgId: session.orgId,
        userId: session.userId,
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing and returns when there are no pending tasks", async () => {
    context.setupMocks();
    const { session } = await seedActiveSession();
    await expect(
      cancelSessionPendingRuns({
        id: session.id,
        orgId: session.orgId,
        userId: session.userId,
      }),
    ).resolves.toBeUndefined();
  });
});
