import { describe, it, expect, beforeEach } from "vitest";
import { POST as unpinThread } from "../route";
import { POST as createThread } from "../../../route";
import {
  createTestRequest,
  createTestCompose,
  setTestChatThreadPinnedAt,
  getTestChatThreadPinnedAt,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { mockAblyPublish } from "../../../../../../../src/__tests__/ably-mock";

const context = testContext();

describe("POST /api/zero/chat-threads/:id/unpin", () => {
  let testComposeId: string;
  let threadId: string;
  let originalUserId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    originalUserId = user.userId;
    mockAblyPublish.mockClear();

    const { composeId } = await createTestCompose(uniqueId("unpin"));
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
    mockAblyPublish.mockClear();
  });

  it("requires authentication", async () => {
    mockClerk({ userId: null });

    const response = await unpinThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/unpin`,
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(401);
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown thread", async () => {
    const response = await unpinThread(
      createTestRequest(
        "http://localhost:3000/api/zero/chat-threads/00000000-0000-0000-0000-000000000000/unpin",
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(404);
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("returns 404 for thread owned by another user", async () => {
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
    await setTestChatThreadPinnedAt(otherThreadId, new Date());

    mockClerk({ userId: originalUserId });
    mockAblyPublish.mockClear();

    const response = await unpinThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${otherThreadId}/unpin`,
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(404);
    expect(mockAblyPublish).not.toHaveBeenCalled();
    const pinnedAt = await getTestChatThreadPinnedAt(otherThreadId);
    expect(pinnedAt).toBeInstanceOf(Date);
  });

  it("clears pinned_at and publishes threadListChanged on success", async () => {
    await setTestChatThreadPinnedAt(threadId, new Date());
    mockAblyPublish.mockClear();

    const response = await unpinThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/unpin`,
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(204);
    await expect(getTestChatThreadPinnedAt(threadId)).resolves.toBeNull();
    expect(mockAblyPublish).toHaveBeenCalledWith("threadListChanged", null);
  });

  it("unpinning an already-unpinned thread is idempotent", async () => {
    const response = await unpinThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/unpin`,
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(204);
    await expect(getTestChatThreadPinnedAt(threadId)).resolves.toBeNull();
    expect(mockAblyPublish).toHaveBeenCalledWith("threadListChanged", null);
  });
});
