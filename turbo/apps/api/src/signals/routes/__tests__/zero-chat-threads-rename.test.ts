import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { delay } from "signal-timers";
import { chatThreadRenameContract } from "@vm0/api-contracts/contracts/chat-threads";
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

async function getThreadRow(threadId: string) {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select({
      title: chatThreads.title,
      renamedAt: chatThreads.renamedAt,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId));
  return row;
}

describe("POST /api/zero/chat-threads/:id/rename", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(chatThreadRenameContract);

    const response = await accept(
      client.rename({
        params: { id: randomUUID() },
        headers: {},
        body: { title: "Renamed" },
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

    const client = setupApp({ context })(chatThreadRenameContract);

    const response = await accept(
      client.rename({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
        body: { title: "Renamed" },
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

    const client = setupApp({ context })(chatThreadRenameContract);

    const response = await accept(
      client.rename({
        params: { id: otherFixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: { title: "Hijacked" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Title must remain untouched.
    const row = await getThreadRow(otherFixture.threadId);
    expect(row?.title).not.toBe("Hijacked");
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("sets title and renamed_at and publishes threadListChanged on success", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadRenameContract);

    await accept(
      client.rename({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: { title: "Renamed" },
      }),
      [204],
    );

    const row = await getThreadRow(fixture.threadId);
    expect(row?.title).toBe("Renamed");
    expect(row?.renamedAt).toBeInstanceOf(Date);

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("renaming again refreshes renamed_at and publishes again", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadRenameContract);

    await accept(
      client.rename({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: { title: "First rename" },
      }),
      [204],
    );
    const firstRow = await getThreadRow(fixture.threadId);
    const firstRenamedAt = firstRow?.renamedAt;
    expect(firstRow?.title).toBe("First rename");
    expect(firstRenamedAt).toBeInstanceOf(Date);

    context.mocks.ably.publish.mockClear();
    // Sleep so the second renamed_at is strictly greater than the first.
    await delay(10, { signal: context.signal });

    await accept(
      client.rename({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
        body: { title: "Second rename" },
      }),
      [204],
    );

    const secondRow = await getThreadRow(fixture.threadId);
    expect(secondRow?.title).toBe("Second rename");
    expect(secondRow?.renamedAt).toBeInstanceOf(Date);
    expect(secondRow!.renamedAt!.getTime()).toBeGreaterThan(
      firstRenamedAt!.getTime(),
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
