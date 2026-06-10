import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroRunsByIdContract } from "@vm0/api-contracts/contracts/zero-runs";
import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";
import { orgMetadata } from "@vm0/db/schema/org-metadata";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { clearAllDetached } from "../../utils";
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
  findZeroChatThreadThroughApi,
} from "./helpers/zero-chat-thread-routes";
import { getZeroScheduleThroughApi } from "./helpers/zero-schedule-routes";
import { seedRun$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("DELETE /api/zero/chat-threads/:id", () => {
  const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });

  // dispatchCancelSideEffects$ reads org credit metadata during the detached
  // queue-drain / credit-reconcile pass; seed it so that work runs cleanly.
  async function seedOrgMetadata(orgId: string): Promise<void> {
    const writeDb = store.set(writeDb$);
    await writeDb
      .insert(orgMetadata)
      .values({ orgId, tier: "free", credits: 10_000 })
      .onConflictDoNothing();
  }

  async function createLinkedScheduleThroughApi(
    fixture: ZeroChatThreadFixture,
  ): Promise<void> {
    const client = setupApp({ context })(zeroSchedulesMainContract);
    await accept(
      client.deploy({
        headers: authHeaders(),
        body: {
          agentId: fixture.composeId,
          chatThreadId: fixture.threadId,
          name: "linked",
          cronExpression: "0 9 * * *",
          prompt: "Daily update",
          description: "Linked schedule",
        },
      }),
      [201],
    );
  }

  async function getRunStatusThroughApi(runId: string): Promise<string> {
    const client = setupApp({ context })(zeroRunsByIdContract);
    const response = await accept(
      client.getById({
        params: { id: runId },
        headers: authHeaders(),
      }),
      [200],
    );
    return response.body.status;
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
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("deletes the thread and returns 404 on route read-after-delete", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    const response = await accept(
      client.delete({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    expect(response.body).toBeUndefined();

    await expect(
      findZeroChatThreadThroughApi(context, fixture.threadId),
    ).resolves.toBeUndefined();
  });

  it("deletes schedules linked to the deleted thread", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await createLinkedScheduleThroughApi(fixture);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.delete({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    await expect(
      findZeroChatThreadThroughApi(context, fixture.threadId),
    ).resolves.toBeUndefined();
    await expect(
      getZeroScheduleThroughApi(context, "linked"),
    ).resolves.toBeUndefined();
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
        headers: authHeaders(),
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
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    await expect(
      findZeroChatThreadThroughApi(context, fixture.threadId),
    ).resolves.toMatchObject({ id: fixture.threadId });
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
      client.delete({
        params: { id: "not-a-uuid" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("id");

    // Seeded thread untouched (path validation short-circuits before lookup).
    await expect(
      findZeroChatThreadThroughApi(context, fixture.threadId),
    ).resolves.toMatchObject({ id: fixture.threadId });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("cancels in-flight runs linked to the deleted thread", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await seedOrgMetadata(fixture.orgId);
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "running",
        chatThreadId: fixture.threadId,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.delete({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    // The run is cancelled synchronously as part of the delete, and the thread
    // is gone.
    await expect(getRunStatusThroughApi(runId)).resolves.toBe("cancelled");
    await expect(
      findZeroChatThreadThroughApi(context, fixture.threadId),
    ).resolves.toBeUndefined();

    // Post-cancel side effects land on the detached path.
    await clearAllDetached();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `runChanged:${runId}`,
      { status: "cancelled" },
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "queue:changed",
      null,
    );
  });

  it("leaves terminal runs linked to the deleted thread untouched", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await seedOrgMetadata(fixture.orgId);
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "completed",
        chatThreadId: fixture.threadId,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.delete({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    // A completed run is not cancellable; its status is preserved.
    await expect(getRunStatusThroughApi(runId)).resolves.toBe("completed");
  });

  it("only cancels runs linked to the thread being deleted", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const other = await track(
      store.set(
        seedZeroChatThread$,
        { userId: fixture.userId, orgId: fixture.orgId },
        context.signal,
      ),
    );
    await seedOrgMetadata(fixture.orgId);
    const { runId: deletedThreadRun } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "running",
        chatThreadId: fixture.threadId,
      },
      context.signal,
    );
    const { runId: otherThreadRun } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: other.composeId,
        status: "running",
        chatThreadId: other.threadId,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.delete({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    // Only the deleted thread's run is cancelled; the sibling thread's run
    // keeps running.
    await expect(getRunStatusThroughApi(deletedThreadRun)).resolves.toBe(
      "cancelled",
    );
    await expect(getRunStatusThroughApi(otherThreadRun)).resolves.toBe(
      "running",
    );

    await clearAllDetached();
  });
});
