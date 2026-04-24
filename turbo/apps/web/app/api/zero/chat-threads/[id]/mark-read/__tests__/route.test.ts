import { describe, it, expect, beforeEach } from "vitest";
import { POST as markRead } from "../route";
import { POST as createThread } from "../../../route";
import {
  createTestRequest,
  createTestCompose,
  insertTestChatMessage,
  setTestChatThreadLastReadMessageId,
  getTestChatThreadLastReadMessageId,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { mockAblyPublish } from "../../../../../../../src/__tests__/ably-mock";

const context = testContext();

describe("POST /api/zero/chat-threads/:id/mark-read", () => {
  let testComposeId: string;
  let threadId: string;
  let originalUserId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    originalUserId = user.userId;
    mockAblyPublish.mockClear();

    const { composeId } = await createTestCompose(uniqueId("mark-read"));
    testComposeId = composeId;

    const createRes = await createThread(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId, title: "Test" }),
      }),
    );
    const created = await createRes.json();
    threadId = created.id;
  });

  it("requires authentication", async () => {
    mockClerk({ userId: null });

    const response = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("returns 404 for unknown thread", async () => {
    const response = await markRead(
      createTestRequest(
        "http://localhost:3000/api/zero/chat-threads/00000000-0000-0000-0000-000000000000/mark-read",
        {
          method: "POST",
        },
      ),
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 for thread owned by another user", async () => {
    // Create thread under a different user (use unique prefix to avoid caching)
    const otherUser = await context.setupUser({ prefix: "other-user" });
    mockClerk({ userId: otherUser.userId });

    const otherComposeRes = await createTestCompose(uniqueId("other-user"));
    const otherThreadRes = await createThread(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: otherComposeRes.composeId }),
      }),
    );
    const { id: otherThreadId } = await otherThreadRes.json();

    // Switch back to the original user and try to mark the other user's thread
    mockClerk({ userId: originalUserId });

    const response = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${otherThreadId}/mark-read`,
        {
          method: "POST",
        },
      ),
    );

    expect(response.status).toBe(404);
  });

  it("stores the current latest message id and returns it", async () => {
    await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "older",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const latest = await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "latest",
      createdAt: new Date("2024-01-01T00:01:00Z"),
    });

    const response = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ lastReadMessageId: latest.id, changed: true });
    await expect(getTestChatThreadLastReadMessageId(threadId)).resolves.toBe(
      latest.id,
    );
  });

  it("does not update or publish when latest message id has not changed", async () => {
    const latest = await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "latest",
    });
    await setTestChatThreadLastReadMessageId(threadId, latest.id);
    mockAblyPublish.mockClear();

    const response = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ lastReadMessageId: latest.id, changed: false });
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("updates to a newer latest message id", async () => {
    const older = await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "older",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const latest = await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "latest",
      createdAt: new Date("2024-01-01T00:01:00Z"),
    });
    await setTestChatThreadLastReadMessageId(threadId, older.id);

    const response = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ lastReadMessageId: latest.id, changed: true });
    await expect(getTestChatThreadLastReadMessageId(threadId)).resolves.toBe(
      latest.id,
    );
  });

  it("returns null and does not publish when the thread has no messages", async () => {
    mockAblyPublish.mockClear();

    const response = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
        },
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ lastReadMessageId: null, changed: false });
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("marks thread read so it shows as read in thread list", async () => {
    const message = await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "hello",
    });

    const markRes = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
        },
      ),
    );
    expect(markRes.status).toBe(200);

    await expect(getTestChatThreadLastReadMessageId(threadId)).resolves.toBe(
      message.id,
    );
  });

  it("publishes Ably signal when the read message id changes", async () => {
    const message = await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "hello",
    });

    await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
        },
      ),
    );

    expect(mockAblyPublish).toHaveBeenCalledWith(
      expect.stringContaining(`chatThreadReadCursorUpdated:${threadId}`),
      { lastReadMessageId: message.id },
    );
    expect(mockAblyPublish).toHaveBeenCalledWith("threadListChanged", null);
  });
});
