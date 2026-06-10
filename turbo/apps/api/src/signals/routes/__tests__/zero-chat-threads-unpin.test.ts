import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { chatThreadUnpinContract } from "@vm0/api-contracts/contracts/chat-threads";
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

describe("POST /api/zero/chat-threads/:id/unpin", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(chatThreadUnpinContract);

    const response = await accept(
      client.unpin({
        params: { id: randomUUID() },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown thread id", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadUnpinContract);

    const response = await accept(
      client.unpin({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for a thread owned by another user without clearing its pinned_at", async () => {
    const otherPinnedAt = new Date("2024-06-01T00:00:00.000Z");
    const otherFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId: `user_${randomUUID().slice(0, 8)}`,
          pinnedAt: otherPinnedAt,
        },
        context.signal,
      ),
    );
    // Authenticate as a different user — must not see another user's thread.
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    const client = setupApp({ context })(chatThreadUnpinContract);

    const response = await accept(
      client.unpin({
        params: { id: otherFixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Cross-user-no-leak: the other user's pinned_at must NOT have been cleared.
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ pinnedAt: chatThreads.pinnedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, otherFixture.threadId));
    expect(row?.pinnedAt).toBeInstanceOf(Date);
  });

  it("clears pinned_at and publishes threadListChanged on success", async () => {
    const fixture = await track(
      store.set(
        seedZeroChatThread$,
        { pinnedAt: new Date("2024-06-01T00:00:00.000Z") },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadUnpinContract);

    const response = await accept(
      client.unpin({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();

    // DB read-after-write
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ pinnedAt: chatThreads.pinnedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    expect(row?.pinnedAt).toBeNull();

    // Ably publish (single threadListChanged event with null payload).
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("is idempotent — unpinning an already-unpinned thread still succeeds and publishes", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadUnpinContract);

    const response = await accept(
      client.unpin({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ pinnedAt: chatThreads.pinnedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    expect(row?.pinnedAt).toBeNull();

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
