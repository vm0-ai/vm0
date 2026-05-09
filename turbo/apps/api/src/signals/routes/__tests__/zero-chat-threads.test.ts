import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadPendingMessageAppendContract,
  chatThreadPendingMessageDeleteContract,
  chatThreadPendingMessageRecallContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockApiShadowCompareRoutes } from "../../context/shadow-compare";
import { writeDb$ } from "../../external/db";
import {
  deleteZeroChatThread$,
  seedZeroChatMessage$,
  seedZeroChatThread$,
  updateZeroChatThreadDraft$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function attachment(id: string) {
  return {
    id,
    url: `https://example.com/${id}.txt`,
    filename: `${id}.txt`,
    contentType: "text/plain",
    size: 100,
  };
}

describe("GET /api/zero/chat-threads/:id", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns thread detail with S3-backed attachment metadata", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "Uploads" }, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "see attached file",
        attachFiles: ["file_123"],
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mocks.s3.listObjects([
      {
        bucket: "test-user-storages",
        key: `uploads/${fixture.userId}/file_123/report.pdf`,
        size: 42,
      },
    ]);
    mockApiShadowCompareRoutes([chatThreadByIdContract.get]);

    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: fixture.threadId,
      title: "Uploads",
      agentId: fixture.composeId,
      latestSessionId: null,
      activeRunIds: [],
      activeRuns: [],
      draftContent: null,
      draftAttachments: null,
      pendingMessage: null,
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
      renamedAt: null,
      chatMessages: [
        {
          role: "user",
          content: "see attached file",
          attachFiles: [
            {
              id: "file_123",
              filename: "report.pdf",
              contentType: "application/pdf",
              size: 42,
              url: `http://localhost:3000/f/${encodeURIComponent(
                fixture.userId.startsWith("user_")
                  ? fixture.userId.slice("user_".length)
                  : fixture.userId,
              )}/file_123/report.pdf`,
            },
          ],
        },
      ],
    });
  });

  it("strips Clerk user_ prefix from attachment file URLs", async () => {
    // Users authenticated via Clerk have IDs prefixed with "user_".
    // The public /f/ URL must omit this prefix (matching web behavior)
    // so the URL is stable regardless of auth source.
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: "user_clerk123" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "attachment",
        attachFiles: ["file_abc"],
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session("user_clerk123", fixture.orgId);
    mocks.s3.listObjects([
      {
        bucket: "test-user-storages",
        key: "uploads/user_clerk123/file_abc/photo.png",
        size: 256,
      },
    ]);
    mockApiShadowCompareRoutes([chatThreadByIdContract.get]);

    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.chatMessages[0]?.attachFiles?.[0]?.url).toBe(
      "http://localhost:3000/f/clerk123/file_abc/photo.png",
    );
  });

  it("returns renamedAt as ISO string when thread was renamed", async () => {
    const renamedDate = new Date("2025-06-01T12:00:00.000Z");
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Custom Name", renamedAt: renamedDate },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockApiShadowCompareRoutes([chatThreadByIdContract.get]);

    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.renamedAt).toBe("2025-06-01T12:00:00.000Z");
  });
});

describe("chat thread pending message routes", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("creates a pending message and clears the draft", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      updateZeroChatThreadDraft$,
      fixture,
      {
        content: "draft before send",
        attachments: [attachment("draft-att")],
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      chatThreadPendingMessageAppendContract,
    );

    const response = await accept(
      client.append({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          content: "first pending",
          attachments: [attachment("pending-att")],
        },
      }),
      [200],
    );

    expect(response.body.pendingMessage.content).toBe("first pending");
    expect(response.body.pendingMessage.attachments).toStrictEqual([
      attachment("pending-att"),
    ]);

    mockApiShadowCompareRoutes([chatThreadByIdContract.get]);
    const detailClient = setupApp({ context })(chatThreadByIdContract);
    const detail = await accept(
      detailClient.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(detail.body.draftContent).toBeNull();
    expect(detail.body.draftAttachments).toBeNull();
    expect(detail.body.pendingMessage?.content).toBe("first pending");
  });

  it("appends content and attachments to the existing pending message", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(
      chatThreadPendingMessageAppendContract,
    );

    const first = await accept(
      client.append({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: { content: "first", attachments: [attachment("first")] },
      }),
      [200],
    );
    const second = await accept(
      client.append({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: { content: "second", attachments: [attachment("second")] },
      }),
      [200],
    );

    expect(second.body.pendingMessage.content).toBe("first\nsecond");
    expect(second.body.pendingMessage.attachments).toStrictEqual([
      attachment("first"),
      attachment("second"),
    ]);
    expect(second.body.pendingMessage.createdAt).toBe(
      first.body.pendingMessage.createdAt,
    );
  });

  it("discards a pending message without changing the draft", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const appendClient = setupApp({ context })(
      chatThreadPendingMessageAppendContract,
    );
    await accept(
      appendClient.append({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: { content: "discard me" },
      }),
      [200],
    );
    await store.set(
      updateZeroChatThreadDraft$,
      fixture,
      { content: "keep draft" },
      context.signal,
    );

    const deleteClient = setupApp({ context })(
      chatThreadPendingMessageDeleteContract,
    );
    const response = await accept(
      deleteClient.delete({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.status).toBe(204);

    mockApiShadowCompareRoutes([chatThreadByIdContract.get]);
    const detailClient = setupApp({ context })(chatThreadByIdContract);
    const detail = await accept(
      detailClient.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(detail.body.pendingMessage).toBeNull();
    expect(detail.body.draftContent).toBe("keep draft");
  });

  it("recalls a pending message into the draft and clears it", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const appendClient = setupApp({ context })(
      chatThreadPendingMessageAppendContract,
    );
    await accept(
      appendClient.append({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          content: "bring me back",
          attachments: [attachment("recall")],
        },
      }),
      [200],
    );
    await store.set(
      updateZeroChatThreadDraft$,
      fixture,
      {
        content: "current draft",
        attachments: [attachment("current")],
      },
      context.signal,
    );

    const recallClient = setupApp({ context })(
      chatThreadPendingMessageRecallContract,
    );
    const response = await accept(
      recallClient.recall({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      draftContent: "bring me back",
      draftAttachments: [attachment("recall")],
      pendingMessage: null,
    });

    mockApiShadowCompareRoutes([chatThreadByIdContract.get]);
    const detailClient = setupApp({ context })(chatThreadByIdContract);
    const detail = await accept(
      detailClient.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(detail.body.pendingMessage).toBeNull();
    expect(detail.body.draftContent).toBe("bring me back");
    expect(detail.body.draftAttachments).toStrictEqual([attachment("recall")]);
  });

  it("requires authentication for append", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const client = setupApp({ context })(
      chatThreadPendingMessageAppendContract,
    );

    const response = await accept(
      client.append({
        params: { id: "00000000-0000-0000-0000-000000000000" },
        headers: { authorization: "Bearer clerk-session" },
        body: { content: "no auth" },
      }),
      [401],
    );

    expect(response.body.error.message).toBe("Not authenticated");
  });

  it("returns 404 for another user's thread", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session("other-user", fixture.orgId);
    const client = setupApp({ context })(
      chatThreadPendingMessageAppendContract,
    );

    const response = await accept(
      client.append({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: { content: "not mine" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe("Chat thread not found");
  });

  it("returns 404 when recalling without a pending message", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(
      chatThreadPendingMessageRecallContract,
    );

    const response = await accept(
      client.recall({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe("Pending message not found");
  });
});

describe("GET /api/zero/chat-threads", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns pinnedAt and renamedAt in thread list", async () => {
    const pinnedDate = new Date("2025-05-01T10:00:00.000Z");
    const renamedDate = new Date("2025-06-01T12:00:00.000Z");
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          title: "Pinned & Renamed",
          pinnedAt: pinnedDate,
          renamedAt: renamedDate,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockApiShadowCompareRoutes([chatThreadsContract.list]);

    const client = setupApp({ context })(chatThreadsContract);

    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    const thread = response.body.threads[0]!;
    expect(thread.pinnedAt).toBe("2025-05-01T10:00:00.000Z");
    expect(thread.renamedAt).toBe("2025-06-01T12:00:00.000Z");
  });

  it("returns pinnedAt and renamedAt as null when not set", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockApiShadowCompareRoutes([chatThreadsContract.list]);

    const client = setupApp({ context })(chatThreadsContract);

    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    const thread = response.body.threads[0]!;
    expect(thread.pinnedAt).toBeNull();
    expect(thread.renamedAt).toBeNull();
  });

  it("returns pinned threads before unpinned threads", async () => {
    const userId = `user_pin_${randomUUID()}`;
    const orgId = `org_pin_${randomUUID()}`;
    const pinned = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "Pinned Thread",
          pinnedAt: new Date("2025-05-01T10:00:00.000Z"),
        },
        context.signal,
      ),
    );
    const unpinned = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "Unpinned Thread" },
        context.signal,
      ),
    );
    const writeDb = store.set(writeDb$);
    await writeDb.insert(chatMessages).values({
      id: randomUUID(),
      chatThreadId: pinned.threadId,
      role: "user",
      content: "msg",
      createdAt: new Date("2025-05-01T00:00:00.000Z"),
    });
    await writeDb.insert(chatMessages).values({
      id: randomUUID(),
      chatThreadId: unpinned.threadId,
      role: "user",
      content: "msg",
      createdAt: new Date("2025-05-02T00:00:00.000Z"),
    });

    mocks.clerk.session(userId, orgId);
    mockApiShadowCompareRoutes([chatThreadsContract.list]);

    const client = setupApp({ context })(chatThreadsContract);

    const response = await accept(
      client.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(2);
    expect(response.body.threads[0]!.id).toBe(pinned.threadId);
    expect(response.body.threads[1]!.id).toBe(unpinned.threadId);
  });
});

describe("GET /api/zero/chat-threads/:threadId/messages", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns paged messages with S3-backed attachment metadata", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "uploaded",
        attachFiles: ["image_file"],
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mocks.s3.listObjects([
      {
        bucket: "test-user-storages",
        key: `uploads/${fixture.userId}/image_file/screenshot.png`,
        size: 128,
      },
    ]);
    mockApiShadowCompareRoutes([chatThreadMessagesContract.list]);

    const client = setupApp({ context })(chatThreadMessagesContract);

    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: { limit: 50 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      messages: [
        {
          id: expect.any(String),
          role: "assistant",
          content: "uploaded",
          attachFiles: [
            {
              id: "image_file",
              filename: "screenshot.png",
              contentType: "image/png",
              size: 128,
              url: `http://localhost:3000/f/${encodeURIComponent(
                fixture.userId.startsWith("user_")
                  ? fixture.userId.slice("user_".length)
                  : fixture.userId,
              )}/image_file/screenshot.png`,
            },
          ],
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      hasHistoryBefore: false,
    });
  });
});
