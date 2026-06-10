import { randomUUID } from "node:crypto";

import { chatThreadMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  addRunToThread$,
  deleteZeroChatThread$,
  seedAssistantEventMessages$,
  seedZeroChatMessage$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { seedRun$ } from "./helpers/zero-usage-insight";

// BDD migration of the legacy `zero-chat-threads-messages.test.ts`.
// The legacy direct DB SELECTs that verified message-row presence /
// absence are replaced by assertions on the public list contract's
// `messages` array. The pagination cursor, generation-template,
// attach-file, and run-error tests are all variations of "owner
// sees correct messages" and chain naturally in GWT-WT-WT walks.
// The 13 legacy `it()`s collapse into 5 BDD `it()`s (auth boundary
// + 3 read-chain + 1 run/error-chain).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function listClient() {
  return setupApp({ context })(chatThreadMessagesContract);
}

describe("BDD GET /api/zero/chat-threads/:threadId/messages — auth boundary", () => {
  it("returns 401 when not authenticated", async () => {
    // When + Then: no auth header → 401.
    const response = await accept(
      listClient().list({
        params: { threadId: randomUUID() },
        query: {},
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.message).toContain("Not authenticated");
  });
});

const trackThread = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});

describe("BDD GET /api/zero/chat-threads/:threadId/messages — read chain", () => {
  it("gwt-wt-wt: 404 missing → 404 cross-user (victim row preserved) → 200 empty → 200 ascending order → 200 generation template on user message", async () => {
    const c = listClient();

    // Given: a fresh user/org with one chat thread.
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 for an unknown thread id.
    const missing = await accept(
      c.list({
        params: { threadId: "00000000-0000-0000-0000-000000000000" },
        query: {},
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body.error.code).toBe("NOT_FOUND");

    // Given: a different user in the same org.
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    // When + Then: cross-user GET returns 404 (no existence leak) and
    // re-auth as owner confirms the thread still has no messages.
    const crossUser = await accept(
      c.list({
        params: { threadId: fixture.threadId },
        query: {},
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body.error.code).toBe("NOT_FOUND");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // Then: an empty thread returns an empty messages list.
    const empty = await accept(
      c.list({
        params: { threadId: fixture.threadId },
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );
    expect(empty.body.messages).toStrictEqual([]);

    // Given: a thread with two messages seeded in ascending order.
    const orderFixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      orderFixture,
      {
        role: "user",
        content: "Hello",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      orderFixture,
      {
        role: "assistant",
        content: "Hi there",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(orderFixture.userId, orderFixture.orgId);

    // When + Then: messages come back in ascending createdAt order.
    const ordered = await accept(
      c.list({
        params: { threadId: orderFixture.threadId },
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );
    expect(ordered.body.messages).toHaveLength(2);
    expect(ordered.body.messages[0]?.role).toBe("user");
    expect(ordered.body.messages[0]?.content).toBe("Hello");
    expect(ordered.body.messages[1]?.role).toBe("assistant");
    expect(ordered.body.messages[1]?.content).toBe("Hi there");
    expect(new Date(ordered.body.messages[0]!.createdAt).toISOString()).toBe(
      ordered.body.messages[0]?.createdAt,
    );

    // Given: a thread with a user message carrying a generation
    // template.
    const tplFixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const generationTemplate = {
      type: "presentation",
      selection: {
        designSystemId: "design-system:test",
        templateId: "template:test",
      },
    } as const;
    await store.set(
      seedZeroChatMessage$,
      tplFixture,
      {
        role: "user",
        content: "Make a template deck",
        generationTemplate,
      },
      context.signal,
    );
    mocks.clerk.session(tplFixture.userId, tplFixture.orgId);

    // When + Then: the list returns the message with its generation
    // template.
    const tpl = await accept(
      c.list({
        params: { threadId: tplFixture.threadId },
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );
    expect(tpl.body.messages).toHaveLength(1);
    expect(tpl.body.messages[0]).toMatchObject({
      role: "user",
      content: "Make a template deck",
      generationTemplate,
    });
  });

  it("gwt-wt-wt: 200 sinceId cursor → 200 limit (hasHistoryBefore true) → 200 beforeId cursor (hasHistoryBefore false)", async () => {
    const c = listClient();

    // Given: a thread with three messages.
    const pageFixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const msg1Id = await store.set(
      seedZeroChatMessage$,
      pageFixture,
      {
        role: "user",
        content: "First",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    const msg2Id = await store.set(
      seedZeroChatMessage$,
      pageFixture,
      {
        role: "assistant",
        content: "Second",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
      context.signal,
    );
    const msg3Id = await store.set(
      seedZeroChatMessage$,
      pageFixture,
      {
        role: "user",
        content: "Third",
        createdAt: new Date("2026-01-01T00:00:02.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(pageFixture.userId, pageFixture.orgId);

    // When + Then: a `sinceId` cursor returns messages strictly
    // after the cursor.
    const since = await accept(
      c.list({
        params: { threadId: pageFixture.threadId },
        query: { sinceId: msg1Id },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(since.body.messages).toHaveLength(2);
    expect(since.body.messages[0]?.content).toBe("Second");
    expect(since.body.messages[1]?.content).toBe("Third");

    // When + Then: a `limit` returns the latest messages and reports
    // `hasHistoryBefore` true.
    const latest = await accept(
      c.list({
        params: { threadId: pageFixture.threadId },
        query: { limit: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(latest.body.messages).toHaveLength(2);
    expect(latest.body.messages[0]?.content).toBe("Second");
    expect(latest.body.messages[1]?.content).toBe("Third");
    expect(latest.body.hasHistoryBefore).toBeTruthy();

    // When + Then: a `beforeId` cursor returns older messages and
    // reports `hasHistoryBefore` false when we walked all the way
    // back to the first message. We use msg3Id as the cursor so
    // the route returns msg1Id, msg2Id in ascending order.
    const before = await accept(
      c.list({
        params: { threadId: pageFixture.threadId },
        query: { beforeId: msg3Id, limit: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(before.body.messages).toHaveLength(2);
    expect(before.body.messages[0]?.id).toBe(msg1Id);
    expect(before.body.messages[1]?.id).toBe(msg2Id);
    expect(before.body.hasHistoryBefore).toBeFalsy();
  });

  it("gwt-wt-wt: 200 attachFiles resolve to CDN URL → 200 attachFiles use persisted metadata (no S3 list)", async () => {
    const c = listClient();

    // Given: a thread with a user message that has only an
    // attachFiles id (no persisted metadata) — the route should
    // resolve to a permanent CDN URL by listing S3.
    const attachFixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      attachFixture,
      {
        role: "user",
        content: "Analyze this data",
        attachFiles: ["paged-resolve-uuid"],
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(attachFixture.userId, attachFixture.orgId);
    mocks.s3.listObjects([
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${attachFixture.userId}/paged-resolve-uuid/data.csv`,
        size: 512,
      },
    ]);

    // When + Then: the list returns a CDN URL for the file.
    const attached = await accept(
      c.list({
        params: { threadId: attachFixture.threadId },
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );
    expect(attached.body.messages).toHaveLength(1);
    const userMsg = attached.body.messages[0];
    expect(userMsg?.role).toBe("user");
    expect(userMsg?.attachFiles).toBeDefined();
    expect(userMsg?.attachFiles).toHaveLength(1);
    expect(userMsg?.attachFiles?.[0]?.id).toBe("paged-resolve-uuid");
    expect(userMsg?.attachFiles?.[0]?.filename).toBe("data.csv");
    expect(userMsg?.attachFiles?.[0]?.url).toBe(
      `https://cdn.vm7.io/artifacts/${encodeURIComponent(attachFixture.userId)}/paged-resolve-uuid/data.csv`,
    );

    // Given: a thread with a user message that has persisted
    // attachment metadata (no S3 list needed).
    context.mocks.s3.send.mockClear();
    const persistedFixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      persistedFixture,
      {
        role: "user",
        content: "Use persisted metadata",
        attachFiles: ["persisted-file"],
        attachFileMetadata: [
          {
            id: "persisted-file",
            filename: "notes.md",
            contentType: "text/markdown",
            size: 256,
            objectKey: `artifacts/${encodeURIComponent(persistedFixture.userId)}/persisted-file/notes.md`,
          },
        ],
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(persistedFixture.userId, persistedFixture.orgId);

    // When + Then: the list returns the persisted metadata and does
    // not call S3.
    const persisted = await accept(
      c.list({
        params: { threadId: persistedFixture.threadId },
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );
    expect(persisted.body.messages).toHaveLength(1);
    expect(persisted.body.messages[0]?.attachFiles).toStrictEqual([
      {
        id: "persisted-file",
        filename: "notes.md",
        contentType: "text/markdown",
        size: 256,
        url: `https://cdn.vm7.io/artifacts/${encodeURIComponent(persistedFixture.userId)}/persisted-file/notes.md`,
      },
    ]);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });
});

describe("BDD GET /api/zero/chat-threads/:threadId/messages — run/error chain", () => {
  it("gwt-wt-wt: 200 run no assistant events (only user row) → 200 run with timeout error (event-backed assistant row has no error)", async () => {
    const c = listClient();

    // Given: a run attached to a thread with no assistant events
    // (status: cancelled). Public surface: no other API produces
    // this state, so a seedRun$ + addRunToThread$ is the only
    // path.
    const thread = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: thread.orgId,
        userId: thread.userId,
        composeId: thread.composeId,
        status: "cancelled",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: thread.threadId, runId, prompt: "test" },
      context.signal,
    );
    mocks.clerk.session(thread.userId, thread.orgId);

    // When + Then: the list returns only the user message and the
    // row has no `status` field.
    const noEvents = await accept(
      c.list({
        params: { threadId: thread.threadId },
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );
    expect(noEvents.body.messages).toHaveLength(1);
    expect(noEvents.body.messages[0]?.role).toBe("user");
    expect(noEvents.body.messages[0]).not.toHaveProperty("status");

    // Given: a run with a terminal error and one event-backed
    // assistant message.
    const errThread = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const errRun = await store.set(
      seedRun$,
      {
        orgId: errThread.orgId,
        userId: errThread.userId,
        composeId: errThread.composeId,
        status: "timeout",
        error: "Run timed out (no heartbeat)",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: errThread.threadId, runId: errRun.runId, prompt: "test" },
      context.signal,
    );
    await store.set(
      seedAssistantEventMessages$,
      {
        threadId: errThread.threadId,
        runId: errRun.runId,
        items: [{ sequenceNumber: 0, content: "Partial response" }],
      },
      context.signal,
    );
    mocks.clerk.session(errThread.userId, errThread.orgId);

    // When + Then: the assistant event row exists and does NOT
    // expose the run-level error.
    const withError = await accept(
      c.list({
        params: { threadId: errThread.threadId },
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );
    const eventRow = withError.body.messages.find((m) => {
      return m.role === "assistant" && m.content === "Partial response";
    });
    expect(eventRow).toBeDefined();
    expect(eventRow?.error).toBeUndefined();
  });
});
