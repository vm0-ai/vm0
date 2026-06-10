import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { delay } from "signal-timers";
import { chatThreadRenameContract } from "@vm0/api-contracts/contracts/chat-threads";

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

describe("POST /api/zero/chat-threads/:id/rename", () => {
  const track = createFixtureTracker<ZeroChatThreadRouteFixture>((fixture) => {
    return deleteZeroChatThreadThroughApi(
      context,
      mocks.clerk.session,
      fixture,
    );
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
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(chatThreadRenameContract);

    const response = await accept(
      client.rename({
        params: { id: randomUUID() },
        headers: authHeaders(),
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
      createZeroChatThreadThroughApi(context, mocks.clerk.session, {
        userId: `user_${randomUUID().slice(0, 8)}`,
        title: "Original",
      }),
    );
    // Authenticate as a different user — must not see another user's thread.
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, otherFixture.orgId);

    const client = setupApp({ context })(chatThreadRenameContract);

    const response = await accept(
      client.rename({
        params: { id: otherFixture.threadId },
        headers: authHeaders(),
        body: { title: "Hijacked" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    const ownerThread = threadFromList(
      await listZeroChatThreadsThroughApi(context),
      otherFixture.threadId,
    );
    expect(ownerThread.title).toBe("Original");
    expect(ownerThread.renamedAt).toBeNull();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("sets title and renamed_at and publishes threadListChanged on success", async () => {
    const fixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session, {
        title: "Original",
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadRenameContract);

    await accept(
      client.rename({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: { title: "Renamed" },
      }),
      [204],
    );

    const thread = threadFromList(
      await listZeroChatThreadsThroughApi(context),
      fixture.threadId,
    );
    expect(thread.title).toBe("Renamed");
    expect(thread.renamedAt).toStrictEqual(expect.any(String));

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("renaming again refreshes renamed_at and publishes again", async () => {
    const fixture = await track(
      createZeroChatThreadThroughApi(context, mocks.clerk.session),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadRenameContract);

    await accept(
      client.rename({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: { title: "First rename" },
      }),
      [204],
    );
    const firstThread = threadFromList(
      await listZeroChatThreadsThroughApi(context),
      fixture.threadId,
    );
    expect(firstThread.title).toBe("First rename");
    expect(firstThread.renamedAt).toStrictEqual(expect.any(String));
    const firstRenamedAt = Date.parse(firstThread.renamedAt ?? "");

    context.mocks.ably.publish.mockClear();
    // Sleep so the second renamed_at is strictly greater than the first.
    await delay(10, { signal: context.signal });

    await accept(
      client.rename({
        params: { id: fixture.threadId },
        headers: authHeaders(),
        body: { title: "Second rename" },
      }),
      [204],
    );

    const secondThread = threadFromList(
      await listZeroChatThreadsThroughApi(context),
      fixture.threadId,
    );
    expect(secondThread.title).toBe("Second rename");
    expect(secondThread.renamedAt).toStrictEqual(expect.any(String));
    expect(Date.parse(secondThread.renamedAt ?? "")).toBeGreaterThan(
      firstRenamedAt,
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
