import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { GET as listThreads, POST } from "../../route";
import { POST as POST_RUN } from "../runs/route";
import {
  createTestRequest,
  createTestCompose,
  createTestSessionWithConversation,
  createTestRunInDb,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { appendChatMessages } from "../../../../../../src/lib/agent-session/agent-session-service";
import { updateChatThreadTitle } from "../../../../../../src/lib/chat-thread";

const context = testContext();

describe("GET /api/zero/chat-threads/:id - Get Thread Detail", () => {
  let testComposeId: string;
  let testUserId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    testUserId = user.userId;

    const { composeId } = await createTestCompose(uniqueId("chat-detail"));
    testComposeId = composeId;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads/some-thread-id",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 404 for non-existent thread", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads/00000000-0000-0000-0000-000000000000",
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
  });

  it("should return thread detail with empty messages", async () => {
    // Create a thread
    const createRequest = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Detail thread",
        }),
      },
    );
    const createResponse = await POST(createRequest);
    const { id: threadId } = await createResponse.json();

    // Get thread detail
    const request = createTestRequest(
      `http://localhost:3000/api/zero/chat-threads/${threadId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(threadId);
    expect(data.title).toBe("Detail thread");
    expect(data.agentComposeId).toBe(testComposeId);
    expect(data.chatMessages).toEqual([]);
    expect(data.latestSessionId).toBeNull();
    expect(data.unsavedRuns).toEqual([]);
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should return chat messages with summaries after run completes", async () => {
    const userId = testUserId;

    // 1. Create thread
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Summaries thread",
        }),
      }),
    );
    const { id: threadId } = await createRes.json();

    // 2. Create a session (linked to a conversation)
    const session = await createTestSessionWithConversation(
      userId,
      testComposeId,
    );

    // 3. Create a completed run whose result references the session
    const { runId } = await createTestRunInDb(userId, testComposeId, {
      status: "completed",
      prompt: "What files changed?",
      result: { agentSessionId: session.id },
    });

    // 4. Append chat messages with summaries to the session
    await appendChatMessages(session.id, userId, [
      { role: "user", content: "What files changed?" },
      {
        role: "assistant",
        content: "Here are the changed files.",
        runId,
        summaries: ["Bash", "Read", "Grep"],
      },
    ]);

    // 5. Link run to thread
    await POST_RUN(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId }),
        },
      ),
    );

    // 6. GET thread detail — summaries should be present
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.chatMessages).toHaveLength(2);

    const assistantMsg = data.chatMessages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe("Here are the changed files.");
    expect(assistantMsg.runId).toBe(runId);
    expect(assistantMsg.summaries).toEqual(["Bash", "Read", "Grep"]);
  });

  it("should not return thread owned by another user", async () => {
    // Create a thread as user 1
    const createRequest = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Private thread",
        }),
      },
    );
    const createResponse = await POST(createRequest);
    const { id: threadId } = await createResponse.json();

    // Switch to user 2
    await context.setupUser({ prefix: "other-user" });

    // Try to get thread as user 2
    const request = createTestRequest(
      `http://localhost:3000/api/zero/chat-threads/${threadId}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
  });

  it("should reflect updated title after updateChatThreadTitle", async () => {
    // Create a thread with initial title
    const createRequest = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Original title",
        }),
      },
    );
    const createResponse = await POST(createRequest);
    const { id: threadId } = await createResponse.json();

    // Update title via service (simulates what the complete webhook does)
    await updateChatThreadTitle(threadId, "AI-Generated Title");

    // Fetch thread detail and verify title was updated
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.title).toBe("AI-Generated Title");
  });

  it("should reflect updated title in thread list", async () => {
    // Create a thread with initial title
    const createRequest = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Before update",
        }),
      },
    );
    const createResponse = await POST(createRequest);
    const { id: threadId } = await createResponse.json();

    // Update title
    await updateChatThreadTitle(threadId, "After AI update");

    // List threads and verify title is reflected
    const listResponse = await listThreads(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentComposeId=${testComposeId}`,
      ),
    );
    const listData = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(listData.threads).toHaveLength(1);
    expect(listData.threads[0].title).toBe("After AI update");
  });
});
