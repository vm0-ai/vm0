import { randomUUID } from "node:crypto";

import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
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

// BDD migration of the legacy `zero-chat-threads.test.ts`. The
// path-validation table (it.each) is preserved as a single BDD
// test that walks the same set of routes by re-using the public
// app. The thread-detail test cases are all "owner sees correct
// detail" and chain naturally in a single GWT-WT-WT walk. The
// messages test cases chain into a single messages chain. The 15
// legacy `it()`s (one is `it.each` covering 13 paths) collapse
// into 3 BDD `it()`s (path validation + detail chain + messages
// chain).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const malformedChatThreadIdCases = [
  { method: "GET", path: "/api/zero/chat-threads/:id", paramName: "id" },
  { method: "PATCH", path: "/api/zero/chat-threads/:id", paramName: "id" },
  { method: "DELETE", path: "/api/zero/chat-threads/:id", paramName: "id" },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/mark-read",
    paramName: "id",
  },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/model-selection",
    paramName: "id",
  },
  { method: "POST", path: "/api/zero/chat-threads/:id/pin", paramName: "id" },
  { method: "POST", path: "/api/zero/chat-threads/:id/unpin", paramName: "id" },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/rename",
    paramName: "id",
  },
  {
    method: "GET",
    path: "/api/zero/chat-threads/:id/messages",
    paramName: "threadId",
  },
  {
    method: "GET",
    path: "/api/zero/chat-threads/:id/artifacts",
    paramName: "threadId",
  },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/artifacts",
    paramName: "threadId",
  },
] as const;

describe("BDD chat thread id path validation", () => {
  it("gwt-wt-wt: malformed threadId returns 400 with the offending param name (auth & DB never reached)", async () => {
    // The contract-bound routes can only be exercised with valid
    // UUIDs at the ts-rest layer. To exercise the zod path
    // validator we go through the public app directly. This is
    // the same shape the legacy `it.each` used.
    const app = (await import("../../../app-factory")).createApp({
      signal: context.signal,
    });

    for (const { method, path, paramName } of malformedChatThreadIdCases) {
      // When: malformed threadId is sent.
      const response = await app.request(path, { method });

      // Then: 400 with the offending param name in the error
      // message (BEFORE auth or DB access).
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        readonly error: { readonly code: string; readonly message: string };
      };
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain(paramName);
    }
  });
});

const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function detailClient() {
  return setupApp({ context })(chatThreadByIdContract);
}

function listThreadsClient() {
  return setupApp({ context })(chatThreadsContract);
}

function messagesClient() {
  return setupApp({ context })(chatThreadMessagesContract);
}

describe("BDD GET /api/zero/chat-threads/:id — detail chain", () => {
  it("gwt-wt-wt: 401 → 404 non-existent → 400 malformed (via contract) → 200 detail metadata only → 200 no messages key → 200 no S3 list → 200 renamedAt ISO → 200 first-run model fallback → 200 stale provider route columns ignored → 404 cross-user → 200 title after update (verified in list) → 200 activeRuns live status (non-terminal only) → 200 activeRuns empty (all terminal)", async () => {
    const c = detailClient();

    // When + Then: 401.
    const unauth = await accept(
      c.get({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session, an unknown thread id.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 404 for non-existent thread id.
    const missing = await accept(
      c.get({
        params: { id: "00000000-0000-0000-0000-000000000000" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });

    // When + Then: 400 for a malformed thread id (the contract's
    // path validation).
    const malformed = await accept(
      c.get({ params: { id: "123" }, headers: authHeaders() }),
      [400],
    );
    expect(malformed.body.error.code).toBe("BAD_REQUEST");
    expect(malformed.body.error.message).toContain("id");

    // Given: a fresh user/org with one chat thread titled "Uploads"
    // and a user message with an attached file. The route should
    // NOT call S3 (S3 fallback only fires for non-persisted
    // metadata; the message is created via the seeded message
    // which carries only an `attachFiles` id).
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
    context.mocks.s3.send.mockClear();

    // When + Then: the detail response carries the expected
    // metadata and does NOT expose chatMessages or call S3.
    const detail = await accept(
      c.get({ params: { id: fixture.threadId }, headers: authHeaders() }),
      [200],
    );
    expect(detail.body).toMatchObject({
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
    expect(detail.body).not.toHaveProperty("chatMessages");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    // Given: a thread with a renamedAt set.
    const renamedDate = new Date("2025-06-01T12:00:00.000Z");
    const renamedFixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Custom Name", renamedAt: renamedDate },
        context.signal,
      ),
    );
    mocks.clerk.session(renamedFixture.userId, renamedFixture.orgId);

    // When + Then: renamedAt is an ISO string.
    const renamed = await accept(
      c.get({
        params: { id: renamedFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(renamed.body.renamedAt).toBe("2025-06-01T12:00:00.000Z");

    // Given: a thread whose first run has a model-first
    // selectedModel.
    const modelFixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Historical model-first thread" },
        context.signal,
      ),
    );
    const { runId: modelRunId } = await store.set(
      seedRun$,
      {
        orgId: modelFixture.orgId,
        userId: modelFixture.userId,
        composeId: modelFixture.composeId,
        status: "completed",
        prompt: "historical opus prompt",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      {
        threadId: modelFixture.threadId,
        runId: modelRunId,
        prompt: "historical opus prompt",
      },
      context.signal,
    );
    await store
      .set(writeDb$)
      .update(zeroRuns)
      .set({ modelProvider: "vm0", selectedModel: "claude-opus-4-7" })
      .where(eq(zeroRuns.id, modelRunId));
    mocks.clerk.session(modelFixture.userId, modelFixture.orgId);

    // When + Then: the route resolves selectedModel from the run
    // and clears stale provider route columns.
    const withModel = await accept(
      c.get({
        params: { id: modelFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(withModel.body.selectedModel).toBe("claude-opus-4-7");
    expect(withModel.body.modelProviderId).toBeNull();
    expect(withModel.body.modelProviderType).toBeNull();
    expect(withModel.body.modelProviderCredentialScope).toBeNull();

    // Given: a thread with stale provider route columns
    // (selectedModel set, but provider route fields populated).
    const staleFixture = await track(
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
        modelProviderId: randomUUID(),
        modelProviderType: "vm0",
        modelProviderCredentialScope: "org",
        selectedModel: "claude-sonnet-4-6",
      })
      .where(eq(chatThreads.id, staleFixture.threadId));
    mocks.clerk.session(staleFixture.userId, staleFixture.orgId);

    // When + Then: the route keeps the selectedModel but ignores
    // the stale provider route columns.
    const stale = await accept(
      c.get({
        params: { id: staleFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(stale.body.selectedModel).toBe("claude-sonnet-4-6");
    expect(stale.body.modelProviderId).toBeNull();
    expect(stale.body.modelProviderType).toBeNull();
    expect(stale.body.modelProviderCredentialScope).toBeNull();

    // Given: a different user in the same org as the original
    // fixture.
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    // When + Then: 404 when accessing another user's thread.
    const crossUser = await accept(
      c.get({ params: { id: fixture.threadId }, headers: authHeaders() }),
      [404],
    );
    expect(crossUser.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });

    // Given: a thread whose title is updated via the AI
    // title-rewrite webhook.
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const titleFixture = await track(
      store.set(
        seedZeroChatThread$,
        { title: "Original title" },
        context.signal,
      ),
    );
    await store.set(
      updateChatThreadTitle$,
      {
        threadId: titleFixture.threadId,
        userId: titleFixture.userId,
        title: "AI-Generated Title",
      },
      context.signal,
    );
    mocks.clerk.session(titleFixture.userId, titleFixture.orgId);

    // When + Then: the detail carries the new title, AND the list
    // (sidebar) carries the new title.
    const titled = await accept(
      c.get({
        params: { id: titleFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(titled.body.title).toBe("AI-Generated Title");
    const list = await accept(
      listThreadsClient().list({ query: {}, headers: authHeaders() }),
      [200],
    );
    const titleRow = [...list.body.pinned, ...list.body.threads].find((t) => {
      return t.id === titleFixture.threadId;
    });
    expect(titleRow?.title).toBe("AI-Generated Title");

    // Given: a thread with three runs (queued, running, completed).
    const runsFixture = await track(
      store.set(seedZeroChatThread$, { title: "Active runs" }, context.signal),
    );
    const { runId: queuedRunId } = await store.set(
      seedRun$,
      {
        orgId: runsFixture.orgId,
        userId: runsFixture.userId,
        composeId: runsFixture.composeId,
        status: "queued",
      },
      context.signal,
    );
    const { runId: runningRunId } = await store.set(
      seedRun$,
      {
        orgId: runsFixture.orgId,
        userId: runsFixture.userId,
        composeId: runsFixture.composeId,
        status: "running",
      },
      context.signal,
    );
    const { runId: doneRunId } = await store.set(
      seedRun$,
      {
        orgId: runsFixture.orgId,
        userId: runsFixture.userId,
        composeId: runsFixture.composeId,
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: runsFixture.threadId, runId: queuedRunId },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: runsFixture.threadId, runId: runningRunId },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: runsFixture.threadId, runId: doneRunId },
      context.signal,
    );
    mocks.clerk.session(runsFixture.userId, runsFixture.orgId);

    // When + Then: activeRuns has the two non-terminal runs with
    // their live status, and activeRunIds is the same set.
    const withRuns = await accept(
      c.get({
        params: { id: runsFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(withRuns.body.activeRuns).toHaveLength(2);
    const byStatus = new Map<string, string>();
    for (const r of withRuns.body.activeRuns ?? []) {
      byStatus.set(r.status, r.id);
    }
    expect(byStatus.get("queued")).toBe(queuedRunId);
    expect(byStatus.get("running")).toBe(runningRunId);
    expect(new Set(withRuns.body.activeRunIds)).toStrictEqual(
      new Set([queuedRunId, runningRunId]),
    );

    // Given: a thread with only a terminal (completed) run.
    const doneFixture = await track(
      store.set(seedZeroChatThread$, { title: "All done" }, context.signal),
    );
    const { runId: completedRunId } = await store.set(
      seedRun$,
      {
        orgId: doneFixture.orgId,
        userId: doneFixture.userId,
        composeId: doneFixture.composeId,
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: doneFixture.threadId, runId: completedRunId },
      context.signal,
    );
    mocks.clerk.session(doneFixture.userId, doneFixture.orgId);

    // When + Then: activeRuns and activeRunIds are both empty.
    const allDone = await accept(
      c.get({
        params: { id: doneFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(allDone.body.activeRuns).toStrictEqual([]);
    expect(allDone.body.activeRunIds).toStrictEqual([]);
  });
});

describe("BDD GET /api/zero/chat-threads/:threadId/messages — append-only chain", () => {
  it("gwt-wt-wt: 200 S3-backed attachFile metadata → 200 revoked + ghost revoker rows still returned (append-only)", async () => {
    const c = messagesClient();

    // Given: a thread with an assistant message carrying an
    // attachFiles id. S3 mock returns the corresponding object
    // so the route can resolve to a CDN URL.
    const s3Fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      s3Fixture,
      {
        role: "assistant",
        content: "uploaded",
        attachFiles: ["image_file"],
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(s3Fixture.userId, s3Fixture.orgId);
    mocks.s3.listObjects([
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${s3Fixture.userId}/image_file/screenshot.png`,
        size: 128,
      },
    ]);

    // When + Then: the list returns the message with S3-resolved
    // attachFile metadata.
    const withAttach = await accept(
      c.list({
        params: { threadId: s3Fixture.threadId },
        query: { limit: 50 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(withAttach.body).toStrictEqual({
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
              url: `https://cdn.vm7.io/artifacts/${encodeURIComponent(s3Fixture.userId)}/image_file/screenshot.png`,
            },
          ],
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      hasHistoryBefore: false,
    });

    // Given: a thread with three rows — a queued user message, a
    // ghost-revoker row pointing at it, and a normal user message
    // that should still be visible (the route is append-only).
    const revokerFixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const writeDb = store.set(writeDb$);
    const queuedId = randomUUID();
    const revokerId = randomUUID();
    const visibleId = randomUUID();
    await writeDb.insert(chatMessages).values([
      {
        id: queuedId,
        chatThreadId: revokerFixture.threadId,
        role: "user",
        content: "queued draft",
        runId: null,
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      {
        id: revokerId,
        chatThreadId: revokerFixture.threadId,
        role: "user",
        content: null,
        runId: null,
        revokesMessageId: queuedId,
        createdAt: new Date("2025-01-01T00:00:01.000Z"),
      },
      {
        id: visibleId,
        chatThreadId: revokerFixture.threadId,
        role: "user",
        content: "kept",
        runId: null,
        createdAt: new Date("2025-01-01T00:00:02.000Z"),
      },
    ]);
    mocks.clerk.session(revokerFixture.userId, revokerFixture.orgId);

    // When + Then: the list returns all three rows in order.
    const appendOnly = await accept(
      c.list({
        params: { threadId: revokerFixture.threadId },
        query: { limit: 50 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(
      appendOnly.body.messages.map((m) => {
        return m.id;
      }),
    ).toStrictEqual([queuedId, revokerId, visibleId]);
  });
});
