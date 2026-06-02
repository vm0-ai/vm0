import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";
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

describe("DELETE /api/zero/chat-threads/:id", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  async function getThreadRowExists(threadId: string): Promise<boolean> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId));
    return Boolean(row);
  }

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(chatThreadByIdContract);

    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
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

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("deletes the thread and removes it from the DB (read-after-delete)", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.delete({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();

    await expect(getThreadRowExists(fixture.threadId)).resolves.toBeFalsy();
  });

  it("returns 204 with body undefined (c.noBody contract)", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.delete({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
  });

  it("returns 404 for a thread owned by another user (no existence leak)", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const otherUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(otherUserId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.delete({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });

    // Victim row preserved.
    await expect(getThreadRowExists(fixture.threadId)).resolves.toBeTruthy();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("publishes threadListChanged once on a successful delete", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.delete({
        params: { id: fixture.threadId },
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

  it("returns 400 for a malformed UUID without touching the DB", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.delete({
        params: { id: "not-a-uuid" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("id");

    // Seeded thread untouched (path validation short-circuits before DB).
    await expect(getThreadRowExists(fixture.threadId)).resolves.toBeTruthy();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});
