import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { seedTestCompose } from "../../../../__tests__/db-test-seeders/agents";
import { seedTestRun } from "../../../../__tests__/db-test-seeders/runs";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import { createSession, endSession } from "../session-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: seed tasks on the stale/ended session to assert cancel hook
import {
  attachTaskRun,
  createVoiceChatTask,
  listVoiceChatTasks,
} from "../task-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify DB side-effects directly
import {
  voiceChatSessions,
  voiceChatEvents,
  voiceChatTasks,
} from "../../../../db/schema/voice-chat";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify agent_runs is not mutated by endSession
import { agentRuns } from "../../../../db/schema/agent-run";

const context = testContext();

async function seedAgent() {
  const { userId, orgId } = await context.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("voice-chat-compose"),
  });
  return { userId, orgId, agentId: composeId };
}

/**
 * Seed a voice-chat session row with a pre-assigned runId pointing at a
 * freshly-seeded agent_runs record. Returns all three so callers can assert
 * side effects on each independently.
 */
async function seedSessionWithRun(options: {
  orgId: string;
  userId: string;
  agentId: string;
  runStatus?: string;
  sessionStatus?: "active" | "preparing" | "ended" | "timeout";
  createdAt?: Date;
}) {
  const { runId } = await seedTestRun(options.userId, options.agentId, {
    orgId: options.orgId,
    status: options.runStatus ?? "running",
    triggerSource: "voice-chat",
  });

  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no seeder for voice_chat_sessions yet
  const [row] = await globalThis.services.db
    .insert(voiceChatSessions)
    .values({
      orgId: options.orgId,
      userId: options.userId,
      agentId: options.agentId,
      runId,
      status: options.sessionStatus ?? "active",
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning();
  return { sessionId: row!.id, runId };
}

describe("endSession — cancelSessionPendingRuns hook", () => {
  it("cancels in-flight tasker runs and marks their task rows failed", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    const session = await createSession(orgId, userId, agentId);
    // Activate so endSession accepts it.
    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: flip status without going through activateSession
    await globalThis.services.db
      .update(voiceChatSessions)
      .set({ status: "active" })
      .where(eq(voiceChatSessions.id, session.id));

    const task = await createVoiceChatTask({
      sessionId: session.id,
      prompt: "ongoing",
    });
    const { runId } = await seedTestRun(userId, agentId, {
      orgId,
      status: "running",
      triggerSource: "voice-chat",
    });
    await attachTaskRun({ taskId: task.id, runId });

    await endSession(session.id, orgId, userId);

    const tasks = await listVoiceChatTasks(session.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("failed");
    expect(tasks[0]!.error).toBe("session ended");

    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify backing run was cancelled
    const [run] = await globalThis.services.db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(run!.status).toBe("cancelled");
  });
});

describe("endSession — graceful slow-brain exit", () => {
  it("updates session status to 'ended' and leaves the slow-brain run untouched", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    // createSession establishes a preparing row so we exercise the full path.
    const session = await createSession(orgId, userId, agentId);
    // Link a seeded running agent_run — simulating an in-flight slow-brain.
    const { runId } = await seedTestRun(userId, agentId, {
      orgId,
      status: "running",
      triggerSource: "voice-chat",
    });
    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: pair up the session with the seeded run
    await globalThis.services.db
      .update(voiceChatSessions)
      .set({ runId })
      .where(eq(voiceChatSessions.id, session.id));

    await endSession(session.id, orgId, userId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify session status flipped
    const db = globalThis.services.db;
    const [sessionAfter] = await db
      .select()
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, session.id));
    expect(sessionAfter!.status).toBe("ended");
    expect(sessionAfter!.endedAt).not.toBeNull();

    // The critical invariant: agent_runs.status MUST NOT be mutated.
    // Slow-brain sees session-end on its next poll and self-exits cleanly;
    // hard-cancelling would abort mid-step and drop the event trail.
    const [runAfter] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(runAfter!.status).toBe("running");
  });
});

describe("createSession — auto-end stale rows", () => {
  it("transitions an existing 'active' row to 'ended' and creates a new row", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    const { sessionId: staleId } = await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "active",
    });

    const fresh = await createSession(orgId, userId, agentId);

    expect(fresh.id).not.toBe(staleId);
    expect(fresh.status).toBe("preparing");

    // eslint-disable-next-line web/no-direct-db-in-tests -- verify DB side effects directly
    const db = globalThis.services.db;
    const [stale] = await db
      .select()
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, staleId));
    expect(stale!.status).toBe("ended");
    expect(stale!.endedAt).not.toBeNull();

    const events = await db
      .select()
      .from(voiceChatEvents)
      .where(eq(voiceChatEvents.sessionId, staleId));
    const endEvents = events.filter((e) => {
      return e.type === "session-end";
    });
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]!.source).toBe("system");
  });

  it("transitions an existing 'preparing' row to 'ended' and creates a new row", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    const { sessionId: staleId } = await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "preparing",
    });

    const fresh = await createSession(orgId, userId, agentId);

    expect(fresh.id).not.toBe(staleId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- verify DB side effects directly
    const db = globalThis.services.db;
    const [stale] = await db
      .select()
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, staleId));
    expect(stale!.status).toBe("ended");
  });

  it("leaves stale run's agent_runs.status untouched (graceful-exit invariant)", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    const { runId } = await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "active",
      runStatus: "running",
    });

    await createSession(orgId, userId, agentId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- invariant check from #10429
    const db = globalThis.services.db;
    const [run] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(run!.status).toBe("running");
  });

  it("cancels in-flight tasks on the stale session it force-ends", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    const { sessionId: staleId } = await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "active",
    });

    const staleTask = await createVoiceChatTask({
      sessionId: staleId,
      prompt: "stale-task",
    });
    const { runId: staleTaskRunId } = await seedTestRun(userId, agentId, {
      orgId,
      status: "running",
      triggerSource: "voice-chat",
    });
    await attachTaskRun({ taskId: staleTask.id, runId: staleTaskRunId });

    await createSession(orgId, userId, agentId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- verify stale session's task row was marked failed
    const db = globalThis.services.db;
    const [taskRow] = await db
      .select()
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.id, staleTask.id));
    expect(taskRow!.status).toBe("failed");
    expect(taskRow!.error).toBe("session ended");

    const [runRow] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, staleTaskRunId));
    expect(runRow!.status).toBe("cancelled");
  });

  it("does not touch other users' active rows", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();
    const other = await context.setupUser({ prefix: "other-user" });

    const { sessionId: otherStaleId } = await seedSessionWithRun({
      orgId: other.orgId,
      userId: other.userId,
      agentId,
      sessionStatus: "active",
    });

    await createSession(orgId, userId, agentId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- cross-user isolation check
    const db = globalThis.services.db;
    const [untouched] = await db
      .select()
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, otherStaleId));
    expect(untouched!.status).toBe("active");
    expect(untouched!.endedAt).toBeNull();
  });

  it("creates the row without emitting a session-end event when no stale row exists", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    const fresh = await createSession(orgId, userId, agentId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- verify no stray events
    const db = globalThis.services.db;
    const events = await db
      .select()
      .from(voiceChatEvents)
      .where(eq(voiceChatEvents.sessionId, fresh.id));
    expect(events).toHaveLength(0);
  });
});
