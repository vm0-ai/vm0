import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { voiceChatSessions } from "../../../../../src/db/schema/voice-chat";
import { eq } from "drizzle-orm";

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

async function insertSession(overrides: {
  status?: string;
  createdAt?: Date;
  lastHeartbeatAt?: Date;
}) {
  initServices();
  const now = new Date();
  const [row] = await globalThis.services.db
    .insert(voiceChatSessions)
    .values({
      orgId: "org_test",
      userId: "user_test",
      status: overrides.status ?? "active",
      createdAt: overrides.createdAt ?? now,
      lastHeartbeatAt: overrides.lastHeartbeatAt ?? now,
    })
    .returning({ id: voiceChatSessions.id });
  return row.id;
}

async function getSessionStatus(id: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select({ status: voiceChatSessions.status })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id));
  return row?.status;
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
    const sessionId = await insertSession({ lastHeartbeatAt: staleTime });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(1);
    expect(await getSessionStatus(sessionId)).toBe("timeout");
  });

  it("should clean up sessions exceeding max duration (>60 min)", async () => {
    const oldTime = new Date(Date.now() - 61 * 60 * 1000); // 61 min ago
    const sessionId = await insertSession({
      createdAt: oldTime,
      lastHeartbeatAt: new Date(), // heartbeat is recent
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(1);
    expect(await getSessionStatus(sessionId)).toBe("timeout");
  });

  it("should not clean up active sessions within thresholds", async () => {
    const recentTime = new Date(Date.now() - 30 * 1000); // 30 sec ago
    const sessionId = await insertSession({
      createdAt: recentTime,
      lastHeartbeatAt: recentTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(0);
    expect(await getSessionStatus(sessionId)).toBe("active");
  });

  it("should not clean up already-ended sessions", async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 1000);
    await insertSession({
      status: "completed",
      lastHeartbeatAt: staleTime,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cleaned).toBe(0);
  });
});
