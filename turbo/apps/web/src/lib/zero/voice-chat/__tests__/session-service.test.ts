import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { seedTestCompose } from "../../../../__tests__/db-test-seeders/agents";
import { seedTestRun } from "../../../../__tests__/db-test-seeders/runs";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import {
  createSession,
  endSession,
  getPriorVoiceChatAgentSessionId,
} from "../session-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify DB side-effects directly
import {
  voiceChatSessions,
  voiceChatEvents,
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
  runResult?: Record<string, unknown>;
  sessionStatus?: "active" | "preparing" | "ended" | "timeout";
  createdAt?: Date;
}) {
  const { runId } = await seedTestRun(options.userId, options.agentId, {
    orgId: options.orgId,
    status: options.runStatus ?? "running",
    result: options.runResult,
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
    // Prior behaviour flipped it to 'cancelled' which prevented the
    // agent-complete webhook from populating result.agentSessionId —
    // and consequently blocked session continuation.
    const [runAfter] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(runAfter!.status).toBe("running");
  });
});

describe("getPriorVoiceChatAgentSessionId", () => {
  it("returns the agentSessionId from the most recent ended session", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "ended",
      runResult: { agentSessionId: "older-cc-session" },
      createdAt: new Date(Date.now() - 2 * 60_000),
    });
    await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "ended",
      runResult: { agentSessionId: "newer-cc-session" },
      createdAt: new Date(Date.now() - 30_000),
    });

    const result = await getPriorVoiceChatAgentSessionId(orgId, userId);
    expect(result).toBe("newer-cc-session");
  });

  it("skips recent sessions whose run did not write an agentSessionId", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    // Earlier session has a valid id.
    await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "ended",
      runResult: { agentSessionId: "earlier-cc-session" },
      createdAt: new Date(Date.now() - 2 * 60_000),
    });
    // More recent session's run never populated result.agentSessionId
    // (e.g. crashed before the agent-complete webhook fired). The 5-row
    // scan should fall through past it.
    await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "ended",
      runResult: { other: "noise" },
      createdAt: new Date(Date.now() - 30_000),
    });

    const result = await getPriorVoiceChatAgentSessionId(orgId, userId);
    expect(result).toBe("earlier-cc-session");
  });

  it("returns null when no prior sessions exist for the user", async () => {
    context.setupMocks();
    const { userId, orgId } = await seedAgent();

    const result = await getPriorVoiceChatAgentSessionId(orgId, userId);
    expect(result).toBeNull();
  });

  it("returns null when every prior session's run lacks an agentSessionId", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "ended",
      runResult: { other: "noise" },
    });

    const result = await getPriorVoiceChatAgentSessionId(orgId, userId);
    expect(result).toBeNull();
  });

  it("matches both 'ended' and 'timeout' status values", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "timeout",
      runResult: { agentSessionId: "cron-timeout-cc-session" },
    });

    const result = await getPriorVoiceChatAgentSessionId(orgId, userId);
    expect(result).toBe("cron-timeout-cc-session");
  });

  it("ignores active and preparing sessions", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    // Active session should be ignored even if its run already has a session id
    // — the session is still in flight, not a valid continuation source yet.
    await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "active",
      runResult: { agentSessionId: "still-running-cc-session" },
    });

    const result = await getPriorVoiceChatAgentSessionId(orgId, userId);
    expect(result).toBeNull();
  });

  it("is scoped by (orgId, userId) — does not leak across users", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    // Seed a prior session owned by a different user. setupUser() caches the
    // default user — passing a distinct prefix forces a fresh (userId, orgId).
    const other = await context.setupUser({ prefix: "other-user" });
    await seedSessionWithRun({
      orgId: other.orgId,
      userId: other.userId,
      agentId,
      sessionStatus: "ended",
      runResult: { agentSessionId: "other-user-cc-session" },
    });

    const result = await getPriorVoiceChatAgentSessionId(orgId, userId);
    expect(result).toBeNull();
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

  it("hands the stale run's agentSessionId to getPriorVoiceChatAgentSessionId for continuation", async () => {
    context.setupMocks();
    const { userId, orgId, agentId } = await seedAgent();

    await seedSessionWithRun({
      orgId,
      userId,
      agentId,
      sessionStatus: "active",
      runResult: { agentSessionId: "prior-cc-session" },
    });

    await createSession(orgId, userId, agentId);

    const prior = await getPriorVoiceChatAgentSessionId(orgId, userId);
    expect(prior).toBe("prior-cc-session");
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
