import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { delay } from "signal-timers";
import { chatThreadPinContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
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

describe("POST /api/zero/chat-threads/:id/pin", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(chatThreadPinContract);

    const response = await accept(
      client.pin({
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

    const client = setupApp({ context })(chatThreadPinContract);

    const response = await accept(
      client.pin({
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

  it("returns 404 for a thread owned by another user (cross-user isolation)", async () => {
    const otherFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: `user_${randomUUID().slice(0, 8)}` },
        context.signal,
      ),
    );
    // Authenticate as a different user — must not see another user's thread.
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    const client = setupApp({ context })(chatThreadPinContract);

    const response = await accept(
      client.pin({
        params: { id: otherFixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // No pin leak: the other user's row stays unpinned.
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ pinnedAt: chatThreads.pinnedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, otherFixture.threadId));
    expect(row?.pinnedAt).toBeNull();
  });

  it("sets pinned_at and publishes threadListChanged on success", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const beforeAt = now();

    const client = setupApp({ context })(chatThreadPinContract);

    await accept(
      client.pin({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    // DB read-after-write
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ pinnedAt: chatThreads.pinnedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    expect(row?.pinnedAt).toBeInstanceOf(Date);
    expect(row!.pinnedAt!.getTime()).toBeGreaterThanOrEqual(beforeAt - 1000);

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("re-pinning refreshes pinned_at and publishes again (idempotent)", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadPinContract);

    await accept(
      client.pin({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    const writeDb = store.set(writeDb$);
    const [first] = await writeDb
      .select({ pinnedAt: chatThreads.pinnedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    context.mocks.ably.publish.mockClear();

    await delay(10, { signal: context.signal });

    await accept(
      client.pin({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    const [second] = await writeDb
      .select({ pinnedAt: chatThreads.pinnedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    expect(second!.pinnedAt!.getTime()).toBeGreaterThan(
      first!.pinnedAt!.getTime(),
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
