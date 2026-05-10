import { createStore } from "ccstate";
import { randomUUID } from "node:crypto";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockApiShadowCompareRoutes } from "../../context/shadow-compare";
import { writeDb$ } from "../../external/db";
import {
  addRunToThread$,
  deleteZeroChatThread$,
  seedAssistantEventMessages$,
  seedZeroChatMessage$,
  seedZeroChatThread$,
  transitionRunStatus$,
  updateChatThreadTitle$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { seedRun$ } from "./helpers/zero-usage-insight";
import { nowDate } from "../../external/time";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

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
    // Each chatMessage must carry its DB row id — the contract marks it
    // optional for back-compat, but production clients dedupe on id, and
    // omitting it caused a shadow divergence regression (see PR #12339).
    for (const message of response.body.chatMessages) {
      expect(message.id).toStrictEqual(expect.any(String));
    }
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

  // --- 12 cases ported 1:1 from web's GET /api/zero/chat-threads/:id describe ---

  it("requires authentication", async () => {
    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.get({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 for non-existent thread id", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.get({
        params: { id: "00000000-0000-0000-0000-000000000000" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 for malformed thread id", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.get({
        params: { id: "123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
  });

  it("returns thread detail with empty messages", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Detail thread" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.id).toBe(fixture.threadId);
    expect(response.body.title).toBe("Detail thread");
    expect(response.body.agentId).toBe(fixture.composeId);
    expect(response.body.chatMessages).toStrictEqual([]);
    expect(response.body.latestSessionId).toBeNull();
  });

  it("returns chat messages after run completes", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Messages thread" },
        context.signal,
      ),
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      { role: "user", content: "What files changed?" },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "Here are the changed files.",
        runId,
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.chatMessages).toHaveLength(2);
    const assistantMsg = response.body.chatMessages.find((m) => {
      return m.role === "assistant";
    });
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.content).toBe("Here are the changed files.");
    expect(assistantMsg?.runId).toBe(runId);
  });

  it("returns 404 when accessing another user's thread", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Private thread" },
        context.signal,
      ),
    );
    // Switch to a different user — same orgId, different userId.
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
  });

  it("reflects updated title after updateChatThreadTitle", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Original title" },
        context.signal,
      ),
    );
    await store.set(
      updateChatThreadTitle$,
      {
        threadId: fixture.threadId,
        userId: fixture.userId,
        title: "AI-Generated Title",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.title).toBe("AI-Generated Title");
  });

  it("returns the updated title in the thread list", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Before update" },
        context.signal,
      ),
    );
    await store.set(
      updateChatThreadTitle$,
      {
        threadId: fixture.threadId,
        userId: fixture.userId,
        title: "After AI update",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    // The list route is still shadow-wrapped (separate Stage 2 issue). Mark
    // it as shadow-compared in this test so the wrapper takes the api side
    // instead of trying to fetch the (non-existent) web upstream.
    mockApiShadowCompareRoutes([chatThreadsContract.list]);
    const listClient = setupApp({ context })(chatThreadsContract);

    const response = await accept(
      listClient.list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.threads).toHaveLength(1);
    expect(response.body.threads[0]?.title).toBe("After AI update");
  });

  it("returns cancelled run as a single user message", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Cancelled run thread" },
        context.signal,
      ),
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "cancelled",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: fixture.threadId, runId },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    // Only the user message is present — no assistant placeholder.
    expect(response.body.chatMessages).toHaveLength(1);
    const userMsg = response.body.chatMessages.find((m) => {
      return m.role === "user";
    });
    expect(userMsg).toBeDefined();
    expect(userMsg?.content).toBe("test prompt");
  });

  it("does not mask event-backed assistant content with run-level timeout error", async () => {
    // Regression test for #12372: event-backed assistant rows must keep
    // their own `content` and NOT inherit the run-level timeout error via
    // the leftJoin fallback.
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Event-backed rows thread" },
        context.signal,
      ),
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "running",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      {
        threadId: fixture.threadId,
        runId,
        prompt: "multi-step prompt",
      },
      context.signal,
    );
    await store.set(
      seedAssistantEventMessages$,
      {
        threadId: fixture.threadId,
        runId,
        items: [
          { sequenceNumber: 0, content: "First partial response" },
          { sequenceNumber: 1, content: "Second partial response" },
        ],
      },
      context.signal,
    );
    await store.set(
      transitionRunStatus$,
      {
        runId,
        status: "timeout",
        completedAt: nowDate(),
        error: "Run timed out (no heartbeat)",
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const eventRows = response.body.chatMessages.filter((m) => {
      return m.role === "assistant" && m.content !== null;
    });
    expect(eventRows).toHaveLength(2);
    for (const row of eventRows) {
      expect(row.content).not.toContain("Run timed out");
    }
  });

  it("returns activeRuns with live status for non-terminal runs", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "Active runs" }, context.signal),
    );
    const { runId: queuedRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "queued",
      },
      context.signal,
    );
    const { runId: runningRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "running",
      },
      context.signal,
    );
    const { runId: doneRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: fixture.threadId, runId: queuedRunId },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: fixture.threadId, runId: runningRunId },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: fixture.threadId, runId: doneRunId },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.activeRuns).toHaveLength(2);
    const byStatus = new Map<string, string>();
    for (const r of response.body.activeRuns ?? []) {
      byStatus.set(r.status, r.id);
    }
    expect(byStatus.get("queued")).toBe(queuedRunId);
    expect(byStatus.get("running")).toBe(runningRunId);
    expect(new Set(response.body.activeRunIds)).toStrictEqual(
      new Set([queuedRunId, runningRunId]),
    );
  });

  it("returns empty activeRuns when all runs are terminal", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, { title: "All done" }, context.signal),
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: fixture.threadId, runId },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.activeRuns).toStrictEqual([]);
    expect(response.body.activeRunIds).toStrictEqual([]);
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

  it("excludes user-revoke ghost rows that revoke a queued message", async () => {
    // Queued user messages start with run_id IS NULL. When the queue drains,
    // a NEW user row (also with run_id IS NULL) is appended pointing at the
    // queued row via revokes_message_id. The web visibility filter drops
    // BOTH the original (revoked) row and the ghost revoker row; the api
    // shadow used to drop only the original, which shifted the page window
    // by one and surfaced as "response shadow divergence" warnings on
    // GET /api/zero/chat-threads/:threadId/messages.
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const writeDb = store.set(writeDb$);

    const queuedId = randomUUID();
    const revokerId = randomUUID();
    const visibleId = randomUUID();
    await writeDb.insert(chatMessages).values([
      {
        id: queuedId,
        chatThreadId: fixture.threadId,
        role: "user",
        content: "queued draft",
        runId: null,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      {
        id: revokerId,
        chatThreadId: fixture.threadId,
        role: "user",
        content: null,
        runId: null,
        revokesMessageId: queuedId,
        createdAt: new Date("2025-01-01T00:00:01.000Z"),
      },
      {
        id: visibleId,
        chatThreadId: fixture.threadId,
        role: "user",
        content: "kept",
        runId: null,
        createdAt: new Date("2025-01-01T00:00:02.000Z"),
      },
    ]);

    mocks.clerk.session(fixture.userId, fixture.orgId);
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

    expect(
      response.body.messages.map((m) => {
        return m.id;
      }),
    ).toStrictEqual([visibleId]);
  });
});
