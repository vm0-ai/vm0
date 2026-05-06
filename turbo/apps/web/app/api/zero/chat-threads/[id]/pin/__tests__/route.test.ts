import { describe, it, expect, beforeEach } from "vitest";
import { POST as pinThread } from "../route";
import { POST as createThread } from "../../../route";
import {
  createTestRequest,
  createTestCompose,
  getTestChatThreadPinnedAt,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { mockAblyPublish } from "../../../../../../../src/__tests__/ably-mock";

const context = testContext();

describe("POST /api/zero/chat-threads/:id/pin", () => {
  let testComposeId: string;
  let threadId: string;
  let originalUserId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    originalUserId = user.userId;
    mockAblyPublish.mockClear();

    const { composeId } = await createTestCompose(uniqueId("pin"));
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

    const response = await pinThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/pin`,
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(401);
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown thread", async () => {
    const response = await pinThread(
      createTestRequest(
        "http://localhost:3000/api/zero/chat-threads/00000000-0000-0000-0000-000000000000/pin",
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

    mockClerk({ userId: originalUserId });
    mockAblyPublish.mockClear();

    const response = await pinThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${otherThreadId}/pin`,
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(404);
    expect(mockAblyPublish).not.toHaveBeenCalled();
    await expect(getTestChatThreadPinnedAt(otherThreadId)).resolves.toBeNull();
  });

  it("sets pinned_at and publishes threadListChanged on success", async () => {
    const beforeAt = Date.now();

    const response = await pinThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/pin`,
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(204);
    const pinnedAt = await getTestChatThreadPinnedAt(threadId);
    expect(pinnedAt).toBeInstanceOf(Date);
    expect(pinnedAt!.getTime()).toBeGreaterThanOrEqual(beforeAt - 1000);
    expect(mockAblyPublish).toHaveBeenCalledWith("threadListChanged", null);
  });

  it("re-pinning refreshes pinned_at and publishes again", async () => {
    await pinThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/pin`,
        { method: "POST" },
      ),
    );
    const firstPinnedAt = await getTestChatThreadPinnedAt(threadId);
    mockAblyPublish.mockClear();

    await new Promise((r) => {
      return setTimeout(r, 10);
    });

    const response = await pinThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/pin`,
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(204);
    const secondPinnedAt = await getTestChatThreadPinnedAt(threadId);
    expect(secondPinnedAt!.getTime()).toBeGreaterThan(firstPinnedAt!.getTime());
    expect(mockAblyPublish).toHaveBeenCalledWith("threadListChanged", null);
  });
});
