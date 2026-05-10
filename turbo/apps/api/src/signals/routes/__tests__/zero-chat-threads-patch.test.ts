import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import {
  chatThreadByIdContract,
  type PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("PATCH /api/zero/chat-threads/:id", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  async function getThreadDraft(threadId: string) {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        draftContent: chatThreads.draftContent,
        draftAttachments: chatThreads.draftAttachments,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId));
    return row;
  }

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.patch({
        params: { id: randomUUID() },
        body: { draftContent: "hello" },
        headers: {},
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-existent thread id", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.patch({
        params: { id: randomUUID() },
        body: { draftContent: "hello" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("updates draft content and returns 204 (DB read-after-write)", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "hello world" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const row = await getThreadDraft(fixture.threadId);
    expect(row?.draftContent).toBe("hello world");
    expect(row?.draftAttachments).toBeNull();
  });

  it("updates draft with attachments and returns 204 (DB read-after-write)", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const attachments: PersistedAttachment[] = [
      {
        id: "att-1",
        url: "https://example.com/file.txt",
        filename: "file.txt",
        contentType: "text/plain",
        size: 100,
      },
    ];

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: {
          draftContent: "with attachment",
          draftAttachments: attachments,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    const row = await getThreadDraft(fixture.threadId);
    expect(row?.draftContent).toBe("with attachment");
    expect(row?.draftAttachments).toStrictEqual(attachments);
  });

  it("clears draft when patching with null values", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { draftContent: "to be cleared" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: null },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    const row = await getThreadDraft(fixture.threadId);
    expect(row?.draftContent).toBeNull();
  });

  it("returns 404 for a thread owned by another user (victim row preserved)", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { draftContent: "owner content" },
        context.signal,
      ),
    );
    const otherUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(otherUserId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "unauthorized" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });

    // Victim row preserved.
    const row = await getThreadDraft(fixture.threadId);
    expect(row?.draftContent).toBe("owner content");
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("publishes threadListChanged when draft transitions empty -> non-empty", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "first keystroke" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("does not publish on continued typing within an existing draft", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);

    // First write — flips false → true and publishes.
    await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "hi" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    context.mocks.ably.publish.mockClear();

    // Second write — still has draft, no transition, no publish.
    await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "hi there" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("publishes threadListChanged when draft is cleared", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { draftContent: "existing" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: null },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("does not publish when patching empty over empty", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: null },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("publishes threadListChanged when only attachments toggle hasDraft", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const attachments: PersistedAttachment[] = [
      {
        id: "att-only",
        url: "https://example.com/file.txt",
        filename: "file.txt",
        contentType: "text/plain",
        size: 100,
      },
    ];

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: null, draftAttachments: attachments },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("returns 404 for a malformed UUID without touching the DB", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.patch({
        params: { id: "not-a-uuid" },
        body: { draftContent: "hello" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });

    // Seeded thread untouched (the malformed-id branch short-circuits before DB).
    const row = await getThreadDraft(fixture.threadId);
    expect(row?.draftContent).toBeNull();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
