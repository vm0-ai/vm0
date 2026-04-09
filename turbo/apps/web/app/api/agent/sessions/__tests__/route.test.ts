import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
  insertOrgCacheEntry,
  appendTestChatMessages,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/agent/sessions", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("session-list"));
    testComposeId = composeId;
  });

  it("should return sessions with chat messages for an agent", async () => {
    // Create a run and complete it (creates a session via checkpoint)
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    // Append chat messages to the session so it appears in the list
    await appendTestChatMessages(agentSessionId, [
      {
        role: "user",
        content: "Hello agent",
        createdAt: new Date().toISOString(),
      },
      {
        role: "assistant",
        content: "Hello user",
        runId,
        createdAt: new Date().toISOString(),
      },
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions?agentComposeId=${testComposeId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sessions).toBeInstanceOf(Array);
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);

    const session = data.sessions.find((s: { id: string }) => {
      return s.id === agentSessionId;
    });
    expect(session).toBeDefined();
    expect(session.messageCount).toBe(2);
    expect(session.preview).toBe("Hello agent");
    expect(session.createdAt).toBeDefined();
    expect(session.updatedAt).toBeDefined();
  });

  it("should return sessions even when no chat messages have been persisted yet", async () => {
    // Create a run and complete it (creates session but without chat messages)
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    const { agentSessionId } = await completeTestRun(user.userId, runId);

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions?agentComposeId=${testComposeId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sessions.length).toBe(1);
    const session = data.sessions[0];
    expect(session.id).toBe(agentSessionId);
    expect(session.messageCount).toBe(0);
    expect(session.preview).toBeNull();
  });

  it("should return 404 when accessing compose from a different org", async () => {
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
      `http://localhost:3000/api/agent/sessions?agentComposeId=${testComposeId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/agent/sessions?agentComposeId=${testComposeId}`,
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });
});
