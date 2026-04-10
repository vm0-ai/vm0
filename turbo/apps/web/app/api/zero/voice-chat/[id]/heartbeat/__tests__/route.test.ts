import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestRequest,
  createTestOrg,
  insertTestVoiceChatSession,
  getTestVoiceChatSessionHeartbeat,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const { POST } = await import("../route");

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/voice-chat";

function heartbeatUrl(sessionId: string): string {
  return `${BASE_URL}/${sessionId}/heartbeat`;
}

function paramsFor(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function setupOrg(userId: string) {
  const slug = uniqueId("zvc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

describe("POST /api/zero/voice-chat/[id]/heartbeat", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(userId);
    orgId = org.orgId;
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(
      createTestRequest(heartbeatUrl("any-id"), { method: "POST" }),
      paramsFor("any-id"),
    );
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 for non-existent session", async () => {
    const response = await POST(
      createTestRequest(heartbeatUrl("00000000-0000-0000-0000-000000000000"), {
        method: "POST",
      }),
      paramsFor("00000000-0000-0000-0000-000000000000"),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 when session belongs to different user", async () => {
    const otherUser = await context.setupUser({ prefix: "other-user" });
    const otherOrg = await setupOrg(otherUser.userId);
    const sessionId = await insertTestVoiceChatSession({
      orgId: otherOrg.orgId,
      userId: otherUser.userId,
    });

    // Switch auth back to original user
    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await POST(
      createTestRequest(heartbeatUrl(sessionId), { method: "POST" }),
      paramsFor(sessionId),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 when session is not active", async () => {
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      status: "ended",
    });

    const response = await POST(
      createTestRequest(heartbeatUrl(sessionId), { method: "POST" }),
      paramsFor(sessionId),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should update lastHeartbeatAt for preparing session", async () => {
    const pastDate = new Date("2024-01-01T00:00:00Z");
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      status: "preparing",
      lastHeartbeatAt: pastDate,
    });

    const response = await POST(
      createTestRequest(heartbeatUrl(sessionId), { method: "POST" }),
      paramsFor(sessionId),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);

    // Verify lastHeartbeatAt was updated
    const heartbeatAt = await getTestVoiceChatSessionHeartbeat(sessionId);
    expect(heartbeatAt!.getTime()).toBeGreaterThan(pastDate.getTime());
  });

  it("should update lastHeartbeatAt for active session", async () => {
    const pastDate = new Date("2024-01-01T00:00:00Z");
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      lastHeartbeatAt: pastDate,
    });

    const response = await POST(
      createTestRequest(heartbeatUrl(sessionId), { method: "POST" }),
      paramsFor(sessionId),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);

    // Verify lastHeartbeatAt was updated
    const heartbeatAt = await getTestVoiceChatSessionHeartbeat(sessionId);
    expect(heartbeatAt!.getTime()).toBeGreaterThan(pastDate.getTime());
  });
});
