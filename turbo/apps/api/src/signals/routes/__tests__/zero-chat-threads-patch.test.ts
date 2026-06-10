import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import {
  chatThreadByIdContract,
  type PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  authHeaders,
  getZeroChatThreadThroughApi,
} from "./helpers/zero-chat-thread-routes";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("PATCH /api/zero/chat-threads/:id", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

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
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("updates draft content and returns 204", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "hello world" },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const thread = await getZeroChatThreadThroughApi(context, fixture.threadId);
    expect(thread.draftContent).toBe("hello world");
    expect(thread.draftAttachments).toBeNull();
  });

  it("updates draft with attachments and returns 204", async () => {
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
        headers: authHeaders(),
      }),
      [204],
    );

    const thread = await getZeroChatThreadThroughApi(context, fixture.threadId);
    expect(thread.draftContent).toBe("with attachment");
    expect(thread.draftAttachments).toStrictEqual(attachments);
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
        headers: authHeaders(),
      }),
      [204],
    );

    const thread = await getZeroChatThreadThroughApi(context, fixture.threadId);
    expect(thread.draftContent).toBeNull();
  });

  it("returns 404 for a thread owned by another user without mutating it", async () => {
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
        headers: authHeaders(),
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const thread = await getZeroChatThreadThroughApi(context, fixture.threadId);
    expect(thread.draftContent).toBe("owner content");
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
        headers: authHeaders(),
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
        headers: authHeaders(),
      }),
      [204],
    );
    context.mocks.ably.publish.mockClear();

    // Second write — still has draft, no transition, no publish.
    await accept(
      client.patch({
        params: { id: fixture.threadId },
        body: { draftContent: "hi there" },
        headers: authHeaders(),
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
        headers: authHeaders(),
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
        headers: authHeaders(),
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
        headers: authHeaders(),
      }),
      [204],
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("returns 400 for a malformed UUID without mutating the thread", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.patch({
        params: { id: "not-a-uuid" },
        body: { draftContent: "hello" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("id");

    // Seeded thread untouched (path validation short-circuits before lookup).
    const thread = await getZeroChatThreadThroughApi(context, fixture.threadId);
    expect(thread.draftContent).toBeNull();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
