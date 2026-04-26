import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import {
  insertTestVoiceChatSession,
  getTestVoiceChatSession,
  countTestVoiceChatSessionsByReasoningStatus,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";
import { nextAfterCallbacks } from "../../../../../src/__tests__/next-after-hooks";

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

  describe("voice-chat passes", () => {
    it("T5 — resets stuck reasoner and queues a triggerReasoning re-tick", async () => {
      const staleReasoningAt = new Date(Date.now() - 5 * 60 * 1000 - 1000);
      const sessionId = await insertTestVoiceChatSession({
        orgId: uniqueId("org-t5"),
        userId: uniqueId("user-t5"),
        reasoningStatus: "running",
        lastSummaryAt: staleReasoningAt,
      });

      // Pre-cron: after() queue is empty.
      expect(nextAfterCallbacks.length).toBe(0);

      const response = await GET(cronRequest("test-cron-secret"));
      const body = await response.json();

      expect(body.reasonerReset).toBeGreaterThanOrEqual(1);
      const row = await getTestVoiceChatSession(sessionId);
      expect(row?.reasoningStatus).toBe("idle");

      expect(nextAfterCallbacks.length).toBe(body.reasonerReset);
    });

    it("T6 — does not touch a non-stuck reasoner (lastSummaryAt within 5 min)", async () => {
      const freshReasoningAt = new Date(Date.now() - 2 * 60 * 1000);
      const sessionId = await insertTestVoiceChatSession({
        orgId: uniqueId("org-t6"),
        userId: uniqueId("user-t6"),
        reasoningStatus: "running",
        lastSummaryAt: freshReasoningAt,
      });

      const response = await GET(cronRequest("test-cron-secret"));
      const body = await response.json();

      expect(typeof body.reasonerReset).toBe("number");
      const row = await getTestVoiceChatSession(sessionId);
      expect(row?.reasoningStatus).toBe("running");
      expect(row?.lastSummaryAt?.getTime()).toBe(freshReasoningAt.getTime());
    });

    it("T9 — caps reasoner stuck-recovery at 50 per tick (LIMIT 50)", async () => {
      const orgId = `org_t9_${Date.now()}`;
      const staleReasoningAt = new Date(Date.now() - 5 * 60 * 1000 - 1000);
      for (let i = 0; i < 60; i++) {
        await insertTestVoiceChatSession({
          orgId,
          userId: `user_t9_${i}`,
          reasoningStatus: "running",
          lastSummaryAt: staleReasoningAt,
        });
      }

      const first = await GET(cronRequest("test-cron-secret"));
      expect((await first.json()).reasonerReset).toBe(50);
      expect(
        await countTestVoiceChatSessionsByReasoningStatus(orgId, "running"),
      ).toBe(10);
      expect(
        await countTestVoiceChatSessionsByReasoningStatus(orgId, "idle"),
      ).toBe(50);

      const second = await GET(cronRequest("test-cron-secret"));
      expect((await second.json()).reasonerReset).toBe(10);
      expect(
        await countTestVoiceChatSessionsByReasoningStatus(orgId, "running"),
      ).toBe(0);
      expect(
        await countTestVoiceChatSessionsByReasoningStatus(orgId, "idle"),
      ).toBe(60);
    });
  });
});
