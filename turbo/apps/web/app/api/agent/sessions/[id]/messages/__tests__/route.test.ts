import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { GET as getSessionById } from "../../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
  insertOrgCacheEntry,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

const context = testContext();

describe("POST /api/agent/sessions/:id/messages", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("session-msg"));
    testComposeId = composeId;
  });

  it("should append messages to a session", async () => {
    // Create a run and complete it (creates session via checkpoint)
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "Hello agent" },
            { role: "assistant", content: "Hello user", runId },
          ],
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    // Verify messages were persisted by fetching the session
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}`,
    );
    const getResponse = await getSessionById(getRequest);
    const sessionData = await getResponse.json();

    expect(sessionData.chatMessages).toHaveLength(2);
    expect(sessionData.chatMessages[0].role).toBe("user");
    expect(sessionData.chatMessages[0].content).toBe("Hello agent");
    expect(sessionData.chatMessages[0].createdAt).toBeDefined();
    expect(sessionData.chatMessages[1].role).toBe("assistant");
    expect(sessionData.chatMessages[1].content).toBe("Hello user");
    expect(sessionData.chatMessages[1].runId).toBe(runId);
  });

  it("should append messages incrementally", async () => {
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    // First batch
    const request1 = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "First message" }],
        }),
      },
    );
    await POST(request1);

    // Second batch
    const request2 = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "assistant", content: "First response" },
            { role: "user", content: "Second message" },
          ],
        }),
      },
    );
    await POST(request2);

    // Verify all messages accumulated
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}`,
    );
    const getResponse = await getSessionById(getRequest);
    const sessionData = await getResponse.json();

    expect(sessionData.chatMessages).toHaveLength(3);
    expect(sessionData.chatMessages[0].content).toBe("First message");
    expect(sessionData.chatMessages[1].content).toBe("First response");
    expect(sessionData.chatMessages[2].content).toBe("Second message");
  });

  it("should return 404 for non-existent session", async () => {
    const nonExistentId = randomUUID();
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${nonExistentId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 when accessing another user's session", async () => {
    // Create another user's session
    const otherUser = await context.setupUser({ prefix: "other" });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-msg-${Date.now()}`,
    );
    const { runId: otherRunId } = await createTestRun(
      otherComposeId,
      "Other user run",
    );
    const { agentSessionId: otherSessionId } = await completeTestRun(
      otherUser.userId,
      otherRunId,
    );

    // Switch back to original user
    mockClerk({ userId: user.userId });

    // Try to append messages to another user's session
    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${otherSessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    // appendChatMessages uses WHERE userId = ... so it's a 404 (not found or not owned)
    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 when appending messages to session from a different org", async () => {
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    // Switch to org B — different org for the same user
    const otherOrgId = uniqueId("org-other");
    const otherOrgSlug = uniqueId("org-other");
    await insertOrgCacheEntry({ orgId: otherOrgId, slug: otherOrgSlug });
    mockClerk({
      userId: user.userId,
      orgId: otherOrgId,
      orgSlug: otherOrgSlug,
      clerkOrgs: [{ id: otherOrgId, slug: otherOrgSlug, name: otherOrgSlug }],
    });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Cross-org message" }],
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 401 when not authenticated", async () => {
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions/${agentSessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });
});
