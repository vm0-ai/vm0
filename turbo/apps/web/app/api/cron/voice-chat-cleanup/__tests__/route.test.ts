import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import {
  insertTestVoiceChatSession,
  getTestVoiceChatSessionStatus,
  getTestVoiceChatEvents,
  insertTestVoiceChatCandidateSession,
  getTestVoiceChatCandidateSession,
  countTestVoiceChatCandidateSessionsByStatus,
  countTestVoiceChatCandidateSessionsByReasoningStatus,
} from "../../../../../src/__tests__/api-test-helpers";
import { mockAblyPublish } from "../../../../../src/__tests__/ably-mock";
import { reloadEnv } from "../../../../../src/env";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request("http://localhost:3000/api/cron/voice-chat-cleanup", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("GET /api/cron/voice-chat-cleanup", () => {
  beforeEach(() => {
    context.setupMocks();
    mockAblyPublish.mockClear();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    reloadEnv();
  });

  it("should return 401 with invalid cron secret", async () => {
    const response = await GET(cronRequest("wrong-secret"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 401 with no authorization header", async () => {
    const response = await GET(cronRequest());
    expect(response.status).toBe(401);
  });

  it("should return zero cleaned when no stale sessions exist", async () => {
    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.cleaned).toBe(0);
  });

  it("should clean up sessions with stale heartbeat (>2 min)", async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 1000); // 3 min ago
    const sessionId = await insertTestVoiceChatSession({
      orgId: "org_test",
      userId: "user_test",
      lastHeartbeatAt: staleTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(1);
    expect(await getTestVoiceChatSessionStatus(sessionId)).toBe("timeout");
  });

  it("should clean up sessions exceeding max duration (>60 min)", async () => {
    const oldTime = new Date(Date.now() - 61 * 60 * 1000); // 61 min ago
    const sessionId = await insertTestVoiceChatSession({
      orgId: "org_test",
      userId: "user_test",
      createdAt: oldTime,
      lastHeartbeatAt: new Date(), // heartbeat is recent
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(1);
    expect(await getTestVoiceChatSessionStatus(sessionId)).toBe("timeout");
  });

  it("should not clean up active sessions within thresholds", async () => {
    const recentTime = new Date(Date.now() - 30 * 1000); // 30 sec ago
    const sessionId = await insertTestVoiceChatSession({
      orgId: "org_test",
      userId: "user_test",
      createdAt: recentTime,
      lastHeartbeatAt: recentTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(0);
    expect(await getTestVoiceChatSessionStatus(sessionId)).toBe("active");
  });

  it("should write session-end event for each timed-out session", async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 1000);
    const sessionId = await insertTestVoiceChatSession({
      orgId: "org_test",
      userId: "user_test",
      lastHeartbeatAt: staleTime,
    });

    await GET(cronRequest("test-cron-secret"));

    const events = await getTestVoiceChatEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session-end",
      source: "system",
    });
  });

  it("should write session-end events for multiple timed-out sessions", async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 1000);
    const sessionId1 = await insertTestVoiceChatSession({
      orgId: "org_test",
      userId: "user_test1",
      lastHeartbeatAt: staleTime,
    });
    const sessionId2 = await insertTestVoiceChatSession({
      orgId: "org_test",
      userId: "user_test2",
      lastHeartbeatAt: staleTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();
    expect(body.cleaned).toBe(2);

    const events1 = await getTestVoiceChatEvents(sessionId1);
    const events2 = await getTestVoiceChatEvents(sessionId2);
    expect(events1).toHaveLength(1);
    expect(events1[0]).toMatchObject({ type: "session-end", source: "system" });
    expect(events2).toHaveLength(1);
    expect(events2[0]).toMatchObject({ type: "session-end", source: "system" });
  });

  it("should not clean up already-ended sessions", async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 1000);
    await insertTestVoiceChatSession({
      orgId: "org_test",
      userId: "user_test",
      status: "completed",
      lastHeartbeatAt: staleTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(0);
  });

  describe("voice-chat-candidate passes", () => {
    it("T1 — times out candidate sessions with stale heartbeat and publishes signal", async () => {
      const mocks = context.setupMocks();
      const staleTime = new Date(Date.now() - 3 * 60 * 1000);
      const sessionId = await insertTestVoiceChatCandidateSession({
        orgId: "org_test",
        userId: "user_test",
        lastHeartbeatAt: staleTime,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.candidateCleaned).toBe(1);
      expect(body.reasonerReset).toBe(0);

      const row = await getTestVoiceChatCandidateSession(sessionId);
      expect(row?.status).toBe("timeout");
      expect(row?.endedAt).not.toBeNull();

      await mocks.flushAfter();
      expect(mockAblyPublish).toHaveBeenCalledWith(
        `voice-chat-candidate:${sessionId}`,
        null,
      );
    });

    it("T2 — times out candidate sessions exceeding max duration (>30 min)", async () => {
      const oldTime = new Date(Date.now() - 31 * 60 * 1000);
      const sessionId = await insertTestVoiceChatCandidateSession({
        orgId: "org_test",
        userId: "user_test",
        createdAt: oldTime,
        lastHeartbeatAt: new Date(),
      });

      const response = await GET(cronRequest("test-cron-secret"));
      const body = await response.json();

      expect(body.candidateCleaned).toBe(1);
      const row = await getTestVoiceChatCandidateSession(sessionId);
      expect(row?.status).toBe("timeout");
    });

    it("T3 — does not touch fresh candidate sessions within thresholds", async () => {
      const recentTime = new Date(Date.now() - 30 * 1000);
      const sessionId = await insertTestVoiceChatCandidateSession({
        orgId: "org_test",
        userId: "user_test",
        createdAt: recentTime,
        lastHeartbeatAt: recentTime,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      const body = await response.json();

      expect(body.candidateCleaned).toBe(0);
      const row = await getTestVoiceChatCandidateSession(sessionId);
      expect(row?.status).toBe("active");
    });

    it("T4 — does not touch already-ended candidate sessions", async () => {
      const staleTime = new Date(Date.now() - 10 * 60 * 1000);
      const sessionId = await insertTestVoiceChatCandidateSession({
        orgId: "org_test",
        userId: "user_test",
        status: "ended",
        lastHeartbeatAt: staleTime,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      const body = await response.json();

      expect(body.candidateCleaned).toBe(0);
      const row = await getTestVoiceChatCandidateSession(sessionId);
      expect(row?.status).toBe("ended");
    });

    it("T5 — resets stuck reasoner and queues a triggerReasoning re-tick", async () => {
      const staleReasoningAt = new Date(Date.now() - 6 * 60 * 1000);
      const sessionId = await insertTestVoiceChatCandidateSession({
        orgId: "org_test",
        userId: "user_test",
        reasoningStatus: "running",
        lastSummaryAt: staleReasoningAt,
      });

      // Pre-cron: after() queue is empty.
      expect(globalThis.nextAfterCallbacks.length).toBe(0);

      const response = await GET(cronRequest("test-cron-secret"));
      const body = await response.json();

      expect(body.reasonerReset).toBe(1);
      expect(body.candidateCleaned).toBe(0);
      const row = await getTestVoiceChatCandidateSession(sessionId);
      expect(row?.reasoningStatus).toBe("idle");

      // Exactly one after() callback was queued: the re-tick for this session.
      // publishUserSignal was not queued because the session is not timed out.
      expect(globalThis.nextAfterCallbacks.length).toBe(1);
    });

    it("T6 — does not touch a non-stuck reasoner (lastSummaryAt within 5 min)", async () => {
      const freshReasoningAt = new Date(Date.now() - 2 * 60 * 1000);
      const sessionId = await insertTestVoiceChatCandidateSession({
        orgId: "org_test",
        userId: "user_test",
        reasoningStatus: "running",
        lastSummaryAt: freshReasoningAt,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      const body = await response.json();

      expect(body.reasonerReset).toBe(0);
      const row = await getTestVoiceChatCandidateSession(sessionId);
      expect(row?.reasoningStatus).toBe("running");
      expect(row?.lastSummaryAt?.getTime()).toBe(freshReasoningAt.getTime());
    });

    it("T7 — idempotent: a second run within the same tick processes nothing", async () => {
      const staleTime = new Date(Date.now() - 3 * 60 * 1000);
      const sessionId = await insertTestVoiceChatCandidateSession({
        orgId: "org_test",
        userId: "user_test",
        lastHeartbeatAt: staleTime,
      });

      const first = await GET(cronRequest("test-cron-secret"));
      expect((await first.json()).candidateCleaned).toBe(1);

      const second = await GET(cronRequest("test-cron-secret"));
      const secondBody = await second.json();
      expect(secondBody.candidateCleaned).toBe(0);

      const row = await getTestVoiceChatCandidateSession(sessionId);
      expect(row?.status).toBe("timeout");
    });

    it("T8 — caps candidate cleanup at 50 per tick (LIMIT 50)", async () => {
      const orgId = `org_t8_${Date.now()}`;
      const staleTime = new Date(Date.now() - 3 * 60 * 1000);
      for (let i = 0; i < 60; i++) {
        await insertTestVoiceChatCandidateSession({
          orgId,
          userId: `user_t8_${i}`,
          lastHeartbeatAt: staleTime,
        });
      }

      const first = await GET(cronRequest("test-cron-secret"));
      expect((await first.json()).candidateCleaned).toBe(50);
      expect(
        await countTestVoiceChatCandidateSessionsByStatus(orgId, "active"),
      ).toBe(10);
      expect(
        await countTestVoiceChatCandidateSessionsByStatus(orgId, "timeout"),
      ).toBe(50);

      const second = await GET(cronRequest("test-cron-secret"));
      expect((await second.json()).candidateCleaned).toBe(10);
      expect(
        await countTestVoiceChatCandidateSessionsByStatus(orgId, "active"),
      ).toBe(0);
      expect(
        await countTestVoiceChatCandidateSessionsByStatus(orgId, "timeout"),
      ).toBe(60);
    });

    it("T9 — caps reasoner stuck-recovery at 50 per tick (LIMIT 50)", async () => {
      const orgId = `org_t9_${Date.now()}`;
      const staleReasoningAt = new Date(Date.now() - 6 * 60 * 1000);
      for (let i = 0; i < 60; i++) {
        await insertTestVoiceChatCandidateSession({
          orgId,
          userId: `user_t9_${i}`,
          reasoningStatus: "running",
          lastSummaryAt: staleReasoningAt,
        });
      }

      const first = await GET(cronRequest("test-cron-secret"));
      expect((await first.json()).reasonerReset).toBe(50);
      expect(
        await countTestVoiceChatCandidateSessionsByReasoningStatus(
          orgId,
          "running",
        ),
      ).toBe(10);
      expect(
        await countTestVoiceChatCandidateSessionsByReasoningStatus(
          orgId,
          "idle",
        ),
      ).toBe(50);

      const second = await GET(cronRequest("test-cron-secret"));
      expect((await second.json()).reasonerReset).toBe(10);
      expect(
        await countTestVoiceChatCandidateSessionsByReasoningStatus(
          orgId,
          "running",
        ),
      ).toBe(0);
      expect(
        await countTestVoiceChatCandidateSessionsByReasoningStatus(
          orgId,
          "idle",
        ),
      ).toBe(60);
    });
  });
});
