import { describe, it, expect, beforeEach } from "vitest";
import { GET, DELETE, PATCH } from "../route";
import { GET as listThreads, POST } from "../../route";
import {
  createTestRequest,
  createTestCompose,
  addTestRunToThread,
  updateTestChatThreadTitle,
  insertTestChatMessage,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { transitionRunStatus } from "../../../../../../src/lib/infra/run/run-status";
import { insertTestAssistantEventMessages } from "../../../../../../src/__tests__/db-test-seeders/agents";

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
          agentId: testComposeId,
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
    expect(data.agentId).toBe(testComposeId);
    expect(data.chatMessages).toEqual([]);
    expect(data.latestSessionId).toBeNull();
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should return chat messages after run completes", async () => {
    // 1. Create thread
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          title: "Messages thread",
        }),
      }),
    );
    const { id: threadId } = await createRes.json();

    // 2. Create a completed run
    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "completed",
      prompt: "What files changed?",
    });

    // 3. Insert messages directly into chat_messages table
    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "What files changed?",
    });
    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "assistant",
      content: "Here are the changed files.",
      runId,
    });

    // 4. GET thread detail — messages should be present
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.chatMessages).toHaveLength(2);

    const assistantMsg = data.chatMessages.find((m: { role: string }) => {
      return m.role === "assistant";
    });
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe("Here are the changed files.");
    expect(assistantMsg.runId).toBe(runId);
  });

  it("should not return thread owned by another user", async () => {
    // Create a thread as user 1
    const createRequest = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
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
          agentId: testComposeId,
          title: "Original title",
        }),
      },
    );
    const createResponse = await POST(createRequest);
    const { id: threadId } = await createResponse.json();

    // Update title via service (simulates what the complete webhook does)
    await updateTestChatThreadTitle(threadId, testUserId, "AI-Generated Title");

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
          agentId: testComposeId,
          title: "Before update",
        }),
      },
    );
    const createResponse = await POST(createRequest);
    const { id: threadId } = await createResponse.json();

    // Update title
    await updateTestChatThreadTitle(threadId, testUserId, "After AI update");

    // List threads and verify title is reflected
    const listResponse = await listThreads(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const listData = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(listData.threads).toHaveLength(1);
    expect(listData.threads[0].title).toBe("After AI update");
  });

  it("should return cancelled run as chat message with error", async () => {
    // Create a thread
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          title: "Cancelled run thread",
        }),
      }),
    );
    const { id: threadId } = await createRes.json();

    // Create a cancelled run (no agentSessionId in result)
    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "cancelled",
      prompt: "This was cancelled",
    });

    // Link run to thread (creates user message and sets zeroRuns.chatThreadId)
    await addTestRunToThread(threadId, runId, testUserId);

    // GET thread detail
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    // chatMessages has only the user message (no assistant placeholder)
    expect(data.chatMessages).toHaveLength(1);

    const userMsg = data.chatMessages.find((m: { role: string }) => {
      return m.role === "user";
    });
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe("test prompt");
  });

  it("should not mask event-backed assistant content with run-level timeout error", async () => {
    // Create a thread
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: testComposeId,
          title: "Event-backed rows thread",
        }),
      }),
    );
    const { id: threadId } = await createRes.json();

    // Simulate a run that produced event-backed assistant rows but then got
    // stamped "timeout" by the cleanup cron (the race this test guards).
    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "running",
      prompt: "multi-step prompt",
    });
    await addTestRunToThread(threadId, runId, testUserId);
    await insertTestAssistantEventMessages(runId, threadId, testUserId, [
      { sequenceNumber: 0, content: "First partial response" },
      { sequenceNumber: 1, content: "Second partial response" },
    ]);
    await transitionRunStatus(
      runId,
      {
        status: "timeout",
        completedAt: new Date(),
        error: "Run timed out (no heartbeat)",
      },
      ["pending", "running"],
    );

    // GET thread detail — event-backed rows must keep their own content and
    // NOT inherit the run-level timeout error via the leftJoin fallback.
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    expect(response.status).toBe(200);
    const data = await response.json();

    const eventRows = data.chatMessages.filter(
      (m: { role: string; content: string | null }) => {
        return m.role === "assistant" && m.content !== null;
      },
    );
    expect(eventRows).toHaveLength(2);
    for (const row of eventRows) {
      expect(row.error).toBeUndefined();
      expect(row.content).not.toContain("Run timed out");
    }
  });
});

describe("DELETE /api/zero/chat-threads/:id - Delete Thread", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-delete"));
    testComposeId = composeId;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads/some-id",
      { method: "DELETE" },
    );
    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 404 for non-existent thread", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads/00000000-0000-0000-0000-000000000000",
      { method: "DELETE" },
    );
    const response = await DELETE(request);

    expect(response.status).toBe(404);
  });

  it("should delete a thread and remove it from the list", async () => {
    // Create a thread
    const createResponse = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "To delete" }),
      }),
    );
    const { id: threadId } = await createResponse.json();

    // Delete the thread
    const deleteResponse = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        { method: "DELETE" },
      ),
    );
    expect(deleteResponse.status).toBe(204);

    // Verify it's gone from GET
    const getResponse = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    expect(getResponse.status).toBe(404);

    // Verify it's gone from list
    const listResponse = await listThreads(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads?agentId=${testComposeId}`,
      ),
    );
    const listData = await listResponse.json();
    expect(listData.threads).toHaveLength(0);
  });

  it("should return 204 with no body (no content-type: application/json)", async () => {
    const createResponse = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "No body" }),
      }),
    );
    const { id: threadId } = await createResponse.json();

    const deleteResponse = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        { method: "DELETE" },
      ),
    );
    expect(deleteResponse.status).toBe(204);
    // The contract uses c.noBody() so the response must not have a JSON
    // content-type header — otherwise ts-rest clients crash parsing empty body.
    const ct = deleteResponse.headers.get("content-type");
    expect(ct === null || !ct.includes("application/json")).toBe(true);
  });

  it("should not allow deleting another user's thread", async () => {
    // Create a thread as user 1
    const createResponse = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Private" }),
      }),
    );
    const { id: threadId } = await createResponse.json();

    // Switch to user 2
    await context.setupUser({ prefix: "other-user" });

    // Try to delete as user 2
    const deleteResponse = await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        { method: "DELETE" },
      ),
    );
    expect(deleteResponse.status).toBe(404);
  });

  it("publishes threadListChanged on successful delete", async () => {
    const createResponse = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Deletable" }),
      }),
    );
    const { id: threadId } = await createResponse.json();
    mockAblyPublish.mockClear();

    await DELETE(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        { method: "DELETE" },
      ),
    );

    expect(mockAblyPublish).toHaveBeenCalledWith("threadListChanged", null);
  });
});

describe("PATCH /api/zero/chat-threads/:id - Update Thread Draft", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-patch"));
    testComposeId = composeId;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads/some-thread-id",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftContent: "hello" }),
      },
    );
    const response = await PATCH(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 404 for non-existent thread", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/chat-threads/00000000-0000-0000-0000-000000000000",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftContent: "hello" }),
      },
    );
    const response = await PATCH(request);

    expect(response.status).toBe(404);
  });

  it("should update draft content and return 204", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    const patchRes = await PATCH(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftContent: "hello world" }),
        },
      ),
    );
    expect(patchRes.status).toBe(204);

    // Verify GET returns the persisted draft
    const getRes = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    const data = await getRes.json();
    expect(data.draftContent).toBe("hello world");
    expect(data.draftAttachments).toBeNull();
  });

  it("should update draft with attachments and return 204", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    const attachments = [
      {
        id: "att-1",
        url: "https://example.com/file.txt",
        filename: "file.txt",
        contentType: "text/plain",
        size: 100,
      },
    ];

    const patchRes = await PATCH(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draftContent: "with attachment",
            draftAttachments: attachments,
          }),
        },
      ),
    );
    expect(patchRes.status).toBe(204);

    const getRes = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    const data = await getRes.json();
    expect(data.draftContent).toBe("with attachment");
    expect(data.draftAttachments).toEqual(attachments);
  });

  it("should clear draft when patching with null values", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    // First set a draft
    await PATCH(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftContent: "to be cleared" }),
        },
      ),
    );

    // Then clear it
    await PATCH(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftContent: null }),
        },
      ),
    );

    const getRes = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    const data = await getRes.json();
    expect(data.draftContent).toBeNull();
  });

  it("should return 404 for another user's thread", async () => {
    // Create thread as user 1
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    // Switch to user 2
    await context.setupUser({ prefix: "other-user" });

    const patchRes = await PATCH(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftContent: "unauthorized" }),
        },
      ),
    );
    expect(patchRes.status).toBe(404);
  });

  it("GET should return null draft fields for a new thread", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    const getRes = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
      ),
    );
    const data = await getRes.json();
    expect(data.draftContent).toBeNull();
    expect(data.draftAttachments).toBeNull();
  });
});
