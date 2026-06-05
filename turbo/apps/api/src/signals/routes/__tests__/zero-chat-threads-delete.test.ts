import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";

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
import { seedRun$ } from "./helpers/zero-usage-insight";

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

  async function getScheduleRowExists(scheduleId: string): Promise<boolean> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ id: zeroAgentSchedules.id })
      .from(zeroAgentSchedules)
      .where(eq(zeroAgentSchedules.id, scheduleId));
    return Boolean(row);
  }

  async function getRunStatus(runId: string): Promise<string | undefined> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    return row?.status;
  }

  // dispatchCancelSideEffects$ reads org credit metadata during the detached
  // queue-drain / credit-reconcile pass; seed it so that work runs cleanly.
  async function seedOrgMetadata(orgId: string): Promise<void> {
    const writeDb = store.set(writeDb$);
    await writeDb
      .insert(orgMetadata)
      .values({ orgId, tier: "free", credits: 10_000 })
      .onConflictDoNothing();
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

  it("deletes schedules linked to the deleted thread", async () => {
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const writeDb = store.set(writeDb$);
    const [schedule] = await writeDb
      .insert(zeroAgentSchedules)
      .values({
        agentId: fixture.composeId,
        userId: fixture.userId,
        orgId: fixture.orgId,
        name: "linked",
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        prompt: "Daily update",
        timezone: "UTC",
        chatThreadId: fixture.threadId,
      })
      .returning({ id: zeroAgentSchedules.id });
    if (!schedule) {
      throw new Error("Expected linked schedule fixture");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadByIdContract);
    await accept(
      client.delete({
        params: { id: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    await expect(getThreadRowExists(fixture.threadId)).resolves.toBeFalsy();
    await expect(getScheduleRowExists(schedule.id)).resolves.toBeFalsy();
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
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    // The run is cancelled synchronously as part of the delete, and the thread
    // is gone.
    await expect(getRunStatus(runId)).resolves.toBe("cancelled");
    await expect(getThreadRowExists(fixture.threadId)).resolves.toBeFalsy();

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
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    // A completed run is not cancellable; its status is preserved.
    await expect(getRunStatus(runId)).resolves.toBe("completed");
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
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    // Only the deleted thread's run is cancelled; the sibling thread's run
    // keeps running.
    await expect(getRunStatus(deletedThreadRun)).resolves.toBe("cancelled");
    await expect(getRunStatus(otherThreadRun)).resolves.toBe("running");

    await clearAllDetached();
  });
});
