import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { POST } from "../../../route";
import {
  createTestRequest,
  createTestCompose,
  insertTestChatMessage,
  addTestRunToThread,
  insertTestAssistantEventMessages,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";
import { transitionRunStatus } from "../../../../../../../src/lib/infra/run/run-status";

const context = testContext();

describe("GET /api/zero/chat-threads/:threadId/messages", () => {
  let testComposeId: string;
  let testUserId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    testUserId = user.userId;

    const { composeId } = await createTestCompose(uniqueId("msg-page"));
    testComposeId = composeId;
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/chat-threads/some-thread-id/messages",
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 404 for a non-existent thread", async () => {
    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/chat-threads/00000000-0000-0000-0000-000000000000/messages",
      ),
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 for a thread owned by another user", async () => {
    // Create thread as user 1
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    expect(createRes.status).toBe(201);
    const { id: threadId } = await createRes.json();

    // Switch to user 2
    await context.setupUser({ prefix: "other-user" });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/messages`,
      ),
    );

    expect(response.status).toBe(404);
  });

  it("should return empty messages list for a thread with no messages", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    expect(createRes.status).toBe(201);
    const { id: threadId } = await createRes.json();

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/messages`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.messages).toEqual([]);
  });

  it("should return messages in ascending createdAt order", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "Hello",
    });
    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "assistant",
      content: "Hi there",
    });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/messages`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].role).toBe("user");
    expect(data.messages[0].content).toBe("Hello");
    expect(data.messages[1].role).toBe("assistant");
    expect(data.messages[1].content).toBe("Hi there");
    // Verify createdAt is a valid ISO 8601 string
    expect(new Date(data.messages[0].createdAt).toISOString()).toBe(
      data.messages[0].createdAt,
    );
  });

  it("should paginate using sinceId cursor", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    const msg1 = await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "First",
    });
    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "assistant",
      content: "Second",
    });
    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "Third",
    });

    // Fetch messages after msg1 (the first message)
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/messages?sinceId=${msg1.id}`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].content).toBe("Second");
    expect(data.messages[1].content).toBe("Third");
  });

  it("returns the latest messages when no cursor is provided and reports hasHistoryBefore", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    // Insert 3 messages: A, B, C. With limit=2, the endpoint returns the two
    // newest messages (B, C) and reports hasHistoryBefore=true because A
    // precedes the returned slice.
    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "A",
    });
    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "assistant",
      content: "B",
    });
    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "C",
    });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/messages?limit=2`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].content).toBe("B");
    expect(data.messages[1].content).toBe("C");
    expect(data.hasHistoryBefore).toBe(true);
  });

  it("should return older messages using beforeId and report whether more history exists", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    const msg1 = await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "A",
    });
    const msg2 = await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "assistant",
      content: "B",
    });
    const msg3 = await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "C",
    });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/messages?beforeId=${msg3.id}&limit=2`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].id).toBe(msg1.id);
    expect(data.messages[1].id).toBe(msg2.id);
    expect(data.hasHistoryBefore).toBe(false);
  });

  it("should return only user message when run has no assistant events", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "cancelled",
      prompt: "test",
    });
    await addTestRunToThread(threadId, runId, testUserId, "test");

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/messages`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].role).toBe("user");
  });

  it("should resolve attach files to permanent /f/ URLs in paged messages", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "Analyze this data",
      attachFiles: ["paged-resolve-uuid"],
    });

    context.mocks.s3.listS3Objects.mockImplementation(
      async (_bucket: string, prefix: string) => {
        if (prefix.includes("paged-resolve-uuid")) {
          return [
            {
              key: `uploads/${testUserId}/paged-resolve-uuid/data.csv`,
              size: 512,
            },
          ];
        }
        return [];
      },
    );

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/messages`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.messages).toHaveLength(1);
    const userMsg = data.messages[0];
    expect(userMsg.role).toBe("user");
    expect(userMsg.attachFiles).toBeDefined();
    expect(userMsg.attachFiles).toHaveLength(1);
    expect(userMsg.attachFiles[0].id).toBe("paged-resolve-uuid");
    expect(userMsg.attachFiles[0].filename).toBe("data.csv");
    expect(userMsg.attachFiles[0].url).toBe(
      `http://localhost:3000/f/${encodeURIComponent(testUserId)}/paged-resolve-uuid/data.csv`,
    );
  });

  it("should not expose run-level error on event-backed assistant rows", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();

    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "running",
      prompt: "test",
    });
    await addTestRunToThread(threadId, runId, testUserId, "test");
    await insertTestAssistantEventMessages(runId, threadId, testUserId, [
      { sequenceNumber: 0, content: "Partial response" },
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

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/messages`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);

    const eventRow = data.messages.find(
      (m: { role: string; content: string | null }) => {
        return m.role === "assistant" && m.content === "Partial response";
      },
    );
    expect(eventRow).toBeDefined();
    expect(eventRow.error).toBeUndefined();
  });
});
