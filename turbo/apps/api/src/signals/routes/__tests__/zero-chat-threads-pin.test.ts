import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { delay } from "signal-timers";
import { chatThreadPinContract } from "@vm0/api-contracts/contracts/chat-threads";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
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

describe("POST /api/zero/chat-threads/:id/pin", () => {
  const track = createFixtureTracker<ZeroChatThreadRouteFixture>((fixture) => {
    return deleteZeroChatThreadThroughApi(
      context,
      mocks.clerk.session,
      fixture,
    );
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
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(chatThreadPinContract);

    const response = await accept(
      client.pin({
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

  it("returns 404 for a thread owned by another user (cross-user isolation)", async () => {
    const otherFixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session, {
        userId: `user_${randomUUID().slice(0, 8)}`,
      }),
    );
    // Authenticate as a different user — must not see another user's thread.
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    const client = setupApp({ context })(chatThreadPinContract);

    const response = await accept(
      client.pin({
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
    expect(ownerList.pinned).toHaveLength(0);
    expect(
      threadFromList(ownerList, otherFixture.threadId).pinnedAt,
    ).toBeNull();
  });

  it("sets pinned_at and publishes threadListChanged on success", async () => {
    const fixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const beforeAt = now();

    const client = setupApp({ context })(chatThreadPinContract);

    await accept(
      client.pin({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    const list = await listZeroChatThreadsThroughApi(context);
    expect(
      list.pinned.map((thread) => {
        return thread.id;
      }),
    ).toContain(fixture.threadId);
    expect(
      list.threads.map((thread) => {
        return thread.id;
      }),
    ).not.toContain(fixture.threadId);
    const thread = threadFromList(list, fixture.threadId);
    expect(thread.pinnedAt).toStrictEqual(expect.any(String));
    expect(Date.parse(thread.pinnedAt ?? "")).toBeGreaterThanOrEqual(
      beforeAt - 1000,
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("re-pinning refreshes pinned_at and publishes again (idempotent)", async () => {
    const fixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadPinContract);

    await accept(
      client.pin({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );
    const first = threadFromList(
      await listZeroChatThreadsThroughApi(context),
      fixture.threadId,
    );
    expect(first.pinnedAt).toStrictEqual(expect.any(String));
    const firstPinnedAt = Date.parse(first.pinnedAt ?? "");
    context.mocks.ably.publish.mockClear();

    await delay(10, { signal: context.signal });

    await accept(
      client.pin({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    const second = threadFromList(
      await listZeroChatThreadsThroughApi(context),
      fixture.threadId,
    );
    expect(second.pinnedAt).toStrictEqual(expect.any(String));
    expect(Date.parse(second.pinnedAt ?? "")).toBeGreaterThan(firstPinnedAt);
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
