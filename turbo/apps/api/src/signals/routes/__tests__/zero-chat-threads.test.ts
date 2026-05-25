import { createStore } from "ccstate";
import { randomUUID } from "node:crypto";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  addRunToThread$,
  deleteZeroChatThread$,
  seedZeroChatMessage$,
  seedZeroChatThread$,
  updateChatThreadTitle$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { seedRun$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/chat-threads/:id", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns thread detail without chat messages", async () => {
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
        bucket: "test-user-artifacts",
        key: `artifacts/${fixture.userId}/file_123/report.pdf`,
        size: 42,
      },
    ]);

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
    });
    expect(response.body).not.toHaveProperty("chatMessages");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
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

  it("returns thread detail metadata only", async () => {
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
    expect(response.body).not.toHaveProperty("chatMessages");
    expect(response.body.latestSessionId).toBeNull();
    expect(response.body.createdAt).toStrictEqual(expect.any(String));
    expect(response.body.updatedAt).toStrictEqual(expect.any(String));
    expect(response.body.draftContent).toBeNull();
    expect(response.body.draftAttachments).toBeNull();
  });

  it("returns the first run model without preserving its provider route", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Historical model-first thread" },
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
        prompt: "historical opus prompt",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      {
        threadId: fixture.threadId,
        runId,
        prompt: "historical opus prompt",
      },
      context.signal,
    );
    await store
      .set(writeDb$)
      .update(zeroRuns)
      .set({ modelProvider: "vm0", selectedModel: "claude-opus-4-7" })
      .where(eq(zeroRuns.id, runId));

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.selectedModel).toBe("claude-opus-4-7");
    expect(response.body.modelProviderId).toBeNull();
    expect(response.body.modelProviderType).toBeNull();
    expect(response.body.modelProviderCredentialScope).toBeNull();
  });

  it("ignores stale provider route columns stored on the thread row", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Stale provider route" },
        context.signal,
      ),
    );
    await store
      .set(writeDb$)
      .update(chatThreads)
      .set({
        modelProviderId: "00000000-0000-4000-a000-000000000123",
        modelProviderType: "vm0",
        modelProviderCredentialScope: "org",
        selectedModel: "claude-sonnet-4-6",
      })
      .where(eq(chatThreads.id, fixture.threadId));

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.get({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.selectedModel).toBe("claude-sonnet-4-6");
    expect(response.body.modelProviderId).toBeNull();
    expect(response.body.modelProviderType).toBeNull();
    expect(response.body.modelProviderCredentialScope).toBeNull();
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
        bucket: "test-user-artifacts",
        key: `artifacts/${fixture.userId}/image_file/screenshot.png`,
        size: 128,
      },
    ]);

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
              url: `https://cdn.vm7.io/artifacts/${encodeURIComponent(fixture.userId)}/image_file/screenshot.png`,
            },
          ],
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      hasHistoryBefore: false,
    });
  });

  it("returns revoked rows and ghost revoker rows append-only, matching web", async () => {
    // The /messages route is an append-only event stream; the client derives
    // its own display projection. Web's getPagedMessages filters by
    // chatThreadId only — no visibleChatMessageCondition. The api side must
    // mirror that behavior or the shadow comparator surfaces divergences
    // every time a user revokes a queued draft (the ghost revoker pattern:
    // role='user', run_id IS NULL, revokes_message_id IS NOT NULL).
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
    ).toStrictEqual([queuedId, revokerId, visibleId]);
  });
});
