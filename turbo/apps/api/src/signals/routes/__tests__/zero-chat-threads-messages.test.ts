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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/chat-threads/:threadId/messages", () => {
  const trackThread = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: "some-thread-id" },
        query: {},
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.message).toContain("Not authenticated");
  });

  it("returns 404 for a non-existent thread", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: "00000000-0000-0000-0000-000000000000" },
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for a thread owned by another user", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns empty messages list for a thread with no messages", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.messages).toStrictEqual([]);
  });

  it("returns messages in ascending createdAt order", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "Hello",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "Hi there",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[0]?.role).toBe("user");
    expect(response.body.messages[0]?.content).toBe("Hello");
    expect(response.body.messages[1]?.role).toBe("assistant");
    expect(response.body.messages[1]?.content).toBe("Hi there");
    expect(new Date(response.body.messages[0]!.createdAt).toISOString()).toBe(
      response.body.messages[0]?.createdAt,
    );
  });

  it("paginates using sinceId cursor", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const msg1Id = await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "First",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "Second",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "Third",
        createdAt: new Date("2026-01-01T00:00:02.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: { sinceId: msg1Id },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[0]?.content).toBe("Second");
    expect(response.body.messages[1]?.content).toBe("Third");
  });

  it("returns the latest messages when no cursor is provided and reports hasHistoryBefore", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "A",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "B",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "C",
        createdAt: new Date("2026-01-01T00:00:02.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: { limit: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[0]?.content).toBe("B");
    expect(response.body.messages[1]?.content).toBe("C");
    expect(response.body.hasHistoryBefore).toBeTruthy();
  });

  it("returns older messages using beforeId and reports whether more history exists", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const msg1Id = await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "A",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    const msg2Id = await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content: "B",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      },
      context.signal,
    );
    const msg3Id = await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "C",
        createdAt: new Date("2026-01-01T00:00:02.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: { beforeId: msg3Id, limit: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[0]?.id).toBe(msg1Id);
    expect(response.body.messages[1]?.id).toBe(msg2Id);
    expect(response.body.hasHistoryBefore).toBeFalsy();
  });

  it("returns only the user message when run has no assistant events", async () => {
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

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: thread.threadId },
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.messages).toHaveLength(1);
    expect(response.body.messages[0]?.role).toBe("user");
    expect(response.body.messages[0]).not.toHaveProperty("status");
  });

  it("resolves attach files to permanent CDN URLs in paged messages", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "user",
        content: "Analyze this data",
        attachFiles: ["paged-resolve-uuid"],
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mocks.s3.listObjects([
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${fixture.userId}/paged-resolve-uuid/data.csv`,
        size: 512,
      },
    ]);

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.messages).toHaveLength(1);
    const userMsg = response.body.messages[0];
    expect(userMsg?.role).toBe("user");
    expect(userMsg?.attachFiles).toBeDefined();
    expect(userMsg?.attachFiles).toHaveLength(1);
    expect(userMsg?.attachFiles?.[0]?.id).toBe("paged-resolve-uuid");
    expect(userMsg?.attachFiles?.[0]?.filename).toBe("data.csv");
    expect(userMsg?.attachFiles?.[0]?.url).toBe(
      `https://cdn.vm7.io/artifacts/${encodeURIComponent(fixture.userId)}/paged-resolve-uuid/data.csv`,
    );
  });

  it("uses persisted attachment metadata without listing S3 objects", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await store.set(
      seedZeroChatMessage$,
      fixture,
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
            objectKey: `artifacts/${encodeURIComponent(fixture.userId)}/persisted-file/notes.md`,
          },
        ],
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.messages).toHaveLength(1);
    expect(response.body.messages[0]?.attachFiles).toStrictEqual([
      {
        id: "persisted-file",
        filename: "notes.md",
        contentType: "text/markdown",
        size: 256,
        url: `https://cdn.vm7.io/artifacts/${encodeURIComponent(fixture.userId)}/persisted-file/notes.md`,
      },
    ]);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("does not expose run-level error on event-backed assistant rows", async () => {
    const thread = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: thread.orgId,
        userId: thread.userId,
        composeId: thread.composeId,
        status: "timeout",
        error: "Run timed out (no heartbeat)",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: thread.threadId, runId, prompt: "test" },
      context.signal,
    );
    await store.set(
      seedAssistantEventMessages$,
      {
        threadId: thread.threadId,
        runId,
        items: [{ sequenceNumber: 0, content: "Partial response" }],
      },
      context.signal,
    );

    mocks.clerk.session(thread.userId, thread.orgId);

    const client = setupApp({ context })(chatThreadMessagesContract);
    const response = await accept(
      client.list({
        params: { threadId: thread.threadId },
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const eventRow = response.body.messages.find((m) => {
      return m.role === "assistant" && m.content === "Partial response";
    });
    expect(eventRow).toBeDefined();
    expect(eventRow?.error).toBeUndefined();
  });
});
