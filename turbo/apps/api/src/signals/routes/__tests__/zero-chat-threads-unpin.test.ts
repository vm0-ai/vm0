import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chatThreadPinContract,
  chatThreadUnpinContract,
} from "@vm0/api-contracts/contracts/chat-threads";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  authHeaders,
  createZeroChatThreadThroughApi,
  deleteZeroChatThreadThroughApi,
  listZeroChatThreadsThroughApi,
  type ZeroChatThreadRouteFixture,
} from "./helpers/zero-chat-thread-routes";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

type ChatThreadListBody = Awaited<
  ReturnType<typeof listZeroChatThreadsThroughApi>
>;

function threadFromList(body: ChatThreadListBody, threadId: string) {
  const thread = [...body.pinned, ...body.threads].find((item) => {
    return item.id === threadId;
  });
  if (!thread) {
    throw new Error(`Expected thread ${threadId} in list response`);
  }
  return thread;
}

async function pinThread(threadId: string) {
  const client = setupApp({ context })(chatThreadPinContract);
  await accept(
    client.pin({
      params: { id: threadId },
      headers: authHeaders(),
    }),
    [204],
  );
}

describe("POST /api/zero/chat-threads/:id/unpin", () => {
  const track = createFixtureTracker<ZeroChatThreadRouteFixture>((fixture) => {
    return deleteZeroChatThreadThroughApi(
      context,
      mocks.clerk.session,
      fixture,
    );
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
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(chatThreadUnpinContract);

    const response = await accept(
      client.unpin({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for a thread owned by another user without clearing its pinned_at", async () => {
    const otherFixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session, {
        userId: `user_${randomUUID().slice(0, 8)}`,
      }),
    );
    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    await pinThread(otherFixture.threadId);
    context.mocks.ably.publish.mockClear();

    // Authenticate as a different user — must not see another user's thread.
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    const client = setupApp({ context })(chatThreadUnpinContract);

    const response = await accept(
      client.unpin({
        params: { id: otherFixture.threadId },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    const ownerList = await listZeroChatThreadsThroughApi(context);
    expect(
      ownerList.pinned.map((thread) => {
        return thread.id;
      }),
    ).toContain(otherFixture.threadId);
    expect(
      threadFromList(ownerList, otherFixture.threadId).pinnedAt,
    ).toStrictEqual(expect.any(String));
  });

  it("clears pinned_at and publishes threadListChanged on success", async () => {
    const fixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await pinThread(fixture.threadId);
    context.mocks.ably.publish.mockClear();

    const client = setupApp({ context })(chatThreadUnpinContract);

    const response = await accept(
      client.unpin({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    expect(response.body).toBeUndefined();

    const list = await listZeroChatThreadsThroughApi(context);
    expect(
      list.pinned.map((thread) => {
        return thread.id;
      }),
    ).not.toContain(fixture.threadId);
    expect(threadFromList(list, fixture.threadId).pinnedAt).toBeNull();

    // Ably publish (single threadListChanged event with null payload).
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("is idempotent — unpinning an already-unpinned thread still succeeds and publishes", async () => {
    const fixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadUnpinContract);

    const response = await accept(
      client.unpin({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    expect(response.body).toBeUndefined();

    const list = await listZeroChatThreadsThroughApi(context);
    expect(threadFromList(list, fixture.threadId).pinnedAt).toBeNull();

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
