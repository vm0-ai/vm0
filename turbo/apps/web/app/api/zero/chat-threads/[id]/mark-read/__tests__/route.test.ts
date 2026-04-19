import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as markRead } from "../route";
import { POST as createThread } from "../../../route";
import {
  createTestRequest,
  createTestCompose,
  insertTestChatMessage,
  setTestChatThreadLastReadAt,
  getTestChatThreadLastReadAt,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { mockAblyPublish } from "../../../../../../../src/__tests__/ably-mock";
import { reloadEnv } from "../../../../../../../src/env";

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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );

    expect(response.status).toBe(404);
  });

  it("advances last_read_at and returns new value", async () => {
    const before = Date.now();
    const response = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    const after = Date.now();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.lastReadAt).toBeDefined();

    const lastReadAt = new Date(data.lastReadAt).getTime();
    expect(lastReadAt).toBeGreaterThanOrEqual(before);
    expect(lastReadAt).toBeLessThanOrEqual(after);
  });

  it("does not rewind last_read_at when cursor is behind current", async () => {
    // Set last_read_at to now
    const firstRes = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    const { lastReadAt: firstValue } = await firstRes.json();

    // Try to set a cursor in the past — should be rejected (forward-only)
    const pastCursor = new Date(
      new Date(firstValue).getTime() - 60000,
    ).toISOString();
    const secondRes = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cursor: pastCursor }),
        },
      ),
    );
    const { lastReadAt: secondValue } = await secondRes.json();

    expect(secondRes.status).toBe(200);
    // Value should be unchanged (cursor was not rewound)
    expect(secondValue).toBe(firstValue);
  });

  it("is idempotent for the same cursor", async () => {
    const cursor = new Date().toISOString();

    const firstRes = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cursor }),
        },
      ),
    );
    const { lastReadAt: first } = await firstRes.json();

    const secondRes = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cursor }),
        },
      ),
    );
    const { lastReadAt: second } = await secondRes.json();

    expect(secondRes.status).toBe(200);
    expect(second).toBe(first);
  });

  it("uses server time when no cursor provided", async () => {
    const before = Date.now();
    const response = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    const after = Date.now();
    const data = await response.json();

    expect(response.status).toBe(200);
    const ts = new Date(data.lastReadAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("marks thread read so it shows as read in thread list", async () => {
    // Insert a message so the thread is "unread" (last_read_at is null)
    await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "hello",
    });
    // Null out last_read_at to simulate an unread thread
    await setTestChatThreadLastReadAt(threadId, null);

    // Mark as read
    const markRes = await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    expect(markRes.status).toBe(200);

    // Verify DB state
    const lastReadAt = await getTestChatThreadLastReadAt(threadId);
    expect(lastReadAt).not.toBeNull();
  });

  it("publishes Ably signal on mark-read", async () => {
    vi.stubEnv("ABLY_API_KEY", "test-key:test-secret");
    reloadEnv();

    await markRead(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/mark-read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );

    expect(mockAblyPublish).toHaveBeenCalledWith(
      expect.stringContaining(`chatThreadReadCursorUpdated:${threadId}`),
      expect.objectContaining({ lastReadAt: expect.any(String) }),
    );
  });
});
