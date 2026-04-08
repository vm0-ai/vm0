import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import {
  insertTestVoiceChatSession,
  getTestVoiceChatSessionStatus,
} from "../../../../../src/__tests__/api-test-helpers";
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
});
