import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  insertTestVoiceChatSession,
  getTestVoiceChatSessionStatus,
  getTestVoiceChatEvents,
  findTestRunRecord,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";

const { POST } = await import("../route");

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/voice-chat";

function endUrl(sessionId: string): string {
  return `${BASE_URL}/${sessionId}/end`;
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

describe("POST /api/zero/voice-chat/[id]/end", () => {
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
      createTestRequest(endUrl("any-id"), { method: "POST" }),
      paramsFor("any-id"),
    );
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 for non-existent session", async () => {
    const response = await POST(
      createTestRequest(endUrl("00000000-0000-0000-0000-000000000000"), {
        method: "POST",
      }),
      paramsFor("00000000-0000-0000-0000-000000000000"),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should return 403 when session belongs to different user", async () => {
    // Create session owned by a different user
    const otherUser = await context.setupUser({ prefix: "other-user" });
    const otherOrg = await setupOrg(otherUser.userId);
    const sessionId = await insertTestVoiceChatSession({
      orgId: otherOrg.orgId,
      userId: otherUser.userId,
    });

    // Switch auth back to original user
    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await POST(
      createTestRequest(endUrl(sessionId), { method: "POST" }),
      paramsFor(sessionId),
    );
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 when session is already ended", async () => {
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      status: "ended",
    });

    const response = await POST(
      createTestRequest(endUrl(sessionId), { method: "POST" }),
      paramsFor(sessionId),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should end session in preparing state", async () => {
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      status: "preparing",
    });

    const response = await POST(
      createTestRequest(endUrl(sessionId), { method: "POST" }),
      paramsFor(sessionId),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);

    // Verify session status updated to "ended"
    const status = await getTestVoiceChatSessionStatus(sessionId);
    expect(status).toBe("ended");

    // Verify session-end event written
    const events = await getTestVoiceChatEvents(sessionId);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("session-end");
    expect(event.source).toBe("system");
  });

  it("should end active session, write event, and cancel run", async () => {
    // Create a run record for FK constraint
    const compose = await createTestCompose(uniqueId("vc-agent"));
    const testRun = await seedTestRun(userId, compose.composeId);

    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      runId: testRun.runId,
    });

    const response = await POST(
      createTestRequest(endUrl(sessionId), { method: "POST" }),
      paramsFor(sessionId),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);

    // Verify session status updated to "ended"
    const status = await getTestVoiceChatSessionStatus(sessionId);
    expect(status).toBe("ended");

    // Verify session-end event written
    const events = await getTestVoiceChatEvents(sessionId);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("session-end");
    expect(event.source).toBe("system");

    // Verify run was cancelled (cancelRun ran for real — pure DB operation)
    const runRecord = await findTestRunRecord(testRun.runId);
    expect(runRecord?.status).toBe("cancelled");
  });
});
