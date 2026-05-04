import { describe, it, expect, beforeEach } from "vitest";
import { POST as renameThread } from "../route";
import { POST as createThread } from "../../../route";
import {
  createTestRequest,
  createTestCompose,
  getTestChatThreadRenamedAt,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { mockAblyPublish } from "../../../../../../../src/__tests__/ably-mock";
import { getChatThread } from "../../../../../../../src/lib/zero/chat-thread";

const context = testContext();

describe("POST /api/zero/chat-threads/:id/rename", () => {
  let testComposeId: string;
  let threadId: string;
  let originalUserId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    originalUserId = user.userId;
    mockAblyPublish.mockClear();

    const { composeId } = await createTestCompose(uniqueId("rename"));
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

    const response = await renameThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown thread", async () => {
    const response = await renameThread(
      createTestRequest(
        "http://localhost:3000/api/zero/chat-threads/00000000-0000-0000-0000-000000000000/rename",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        },
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

    const response = await renameThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${otherThreadId}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Hijacked" }),
        },
      ),
    );

    expect(response.status).toBe(404);
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("sets title and renamed_at and publishes threadListChanged on success", async () => {
    const response = await renameThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        },
      ),
    );

    expect(response.status).toBe(204);
    const renamedAt = await getTestChatThreadRenamedAt(threadId);
    expect(renamedAt).toBeInstanceOf(Date);
    expect(mockAblyPublish).toHaveBeenCalledWith("threadListChanged", null);

    const thread = await getChatThread(threadId, originalUserId);
    expect(thread.title).toBe("Renamed");
  });

  it("renaming again refreshes renamed_at and publishes again", async () => {
    await renameThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "First rename" }),
        },
      ),
    );
    const firstRenamedAt = await getTestChatThreadRenamedAt(threadId);
    mockAblyPublish.mockClear();

    await new Promise((r) => {
      return setTimeout(r, 10);
    });

    const response = await renameThread(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Second rename" }),
        },
      ),
    );

    expect(response.status).toBe(204);
    const secondRenamedAt = await getTestChatThreadRenamedAt(threadId);
    expect(secondRenamedAt!.getTime()).toBeGreaterThan(
      firstRenamedAt!.getTime(),
    );
    expect(mockAblyPublish).toHaveBeenCalledWith("threadListChanged", null);
  });
});
