import { randomUUID } from "node:crypto";

import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { createStore } from "ccstate";

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

// BDD migration of the legacy `zero-chat-threads-delete.test.ts`. The
// legacy direct DB SELECTs that verified row removal (thread row,
// linked schedule row, run status, sibling run untouched) are replaced
// by assertions on the public list and getById contracts:
//  - thread removal: list endpoint no longer reports the thread
//  - linked schedule cascade: schedules list no longer reports the
//    schedule (the route cascades the schedule with the thread)
//  - run cancellation: zeroRunsByIdContract.getById reports
//    status: "cancelled" for the deleted thread's run
//  - sibling run untouched: zeroRunsByIdContract.getById reports
//    status: "running" for the sibling thread's run
//  - victim row preserved: re-authenticating as the owner and
//    inspecting the list still shows the thread.
// The 11 legacy `it()`s collapse into 3 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function deleteClient() {
  return setupApp({ context })(chatThreadByIdContract);
}

function listThreadsClient() {
  return setupApp({ context })(chatThreadsContract);
}

async function seedOrgMetadata(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(orgMetadata)
    .values({ orgId, tier: "free", credits: 10_000 })
    .onConflictDoNothing();
}

async function findThread(threadId: string) {
  const list = await accept(
    listThreadsClient().list({ headers: authHeaders() }),
    [200],
  );
  return [...list.body.pinned, ...list.body.threads].find((entry) => {
    return entry.id === threadId;
  });
}

async function listSchedules(
  headers: Record<string, string> = authHeaders(),
): Promise<{ readonly name: string; readonly chatThreadId: string | null }[]> {
  const app = (await import("../../../app-factory")).createApp({
    signal: context.signal,
  });
  const response = await app.request("/api/zero/schedules", {
    method: "GET",
    headers,
  });
  if (response.status !== 200) {
    return [];
  }
  const body = (await response.json()) as {
    schedules: { name: string; chatThreadId: string | null }[];
  };
  return body.schedules;
}

async function getRunStatus(runId: string): Promise<string | undefined> {
  const app = (await import("../../../app-factory")).createApp({
    signal: context.signal,
  });
  const response = await app.request(`/api/zero/runs/${runId}`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (response.status !== 200) {
    return undefined;
  }
  const body = (await response.json()) as { runId: string; status: string };
  return body.status;
}

describe("BDD DELETE /api/zero/chat-threads/:id — auth boundary", () => {
  it("returns 401 when unauthenticated and does not publish to Ably", async () => {
    context.mocks.ably.publish.mockClear();

    // When + Then: no auth header → 401.
    const response = await accept(
      deleteClient().delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});

const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});

describe("BDD DELETE /api/zero/chat-threads/:id — delete chain", () => {
  it("gwt-wt-wt: 404 missing → 404 cross-user (victim row preserved) → 204 own (verified via list)", async () => {
    const c = deleteClient();
    context.mocks.ably.publish.mockClear();

    // Given: a fresh user/org with one chat thread.
    const fixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 for an unknown thread.
    const missing = await accept(
      c.delete({ params: { id: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Given: a different user in the same org tries to delete the
    // fixture thread.
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, fixture.orgId);

    // When + Then: cross-user delete is 404 (no existence leak) and
    // does not publish; re-auth as owner confirms the thread is
    // still in the list (victim row preserved).
    const crossUser = await accept(
      c.delete({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const stillThere = await findThread(fixture.threadId);
    expect(stillThere?.id).toBe(fixture.threadId);
    context.mocks.ably.publish.mockClear();

    // When: the owner deletes the thread.
    const deleted = await accept(
      c.delete({
        params: { id: fixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(deleted.body).toBeUndefined();

    // Then: the public list no longer reports the thread and Ably
    // was published to once with `threadListChanged`.
    const survivor = await findThread(fixture.threadId);
    expect(survivor).toBeUndefined();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});

describe("BDD DELETE /api/zero/chat-threads/:id — cascade chain", () => {
  it("gwt-wt-wt: 204 deletes linked schedule (verified via schedules list) → 204 cancels own run (verified via getById) → 204 leaves sibling run untouched (verified via getById)", async () => {
    const c = deleteClient();
    context.mocks.ably.publish.mockClear();

    // Given: a thread linked to a schedule.
    const scheduleFixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const writeDb = store.set(writeDb$);
    const [schedule] = await writeDb
      .insert(zeroAgentSchedules)
      .values({
        agentId: scheduleFixture.composeId,
        userId: scheduleFixture.userId,
        orgId: scheduleFixture.orgId,
        name: "linked-to-thread",
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        prompt: "Daily update",
        timezone: "UTC",
        chatThreadId: scheduleFixture.threadId,
      })
      .returning({ id: zeroAgentSchedules.id });
    if (!schedule) {
      throw new Error("Expected linked schedule fixture");
    }
    mocks.clerk.session(scheduleFixture.userId, scheduleFixture.orgId);

    // When: the owner deletes the thread.
    await accept(
      c.delete({
        params: { id: scheduleFixture.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    // Then: the schedules list no longer reports the linked schedule
    // (the route cascades the schedule with the thread).
    const afterList = await listSchedules();
    const linkedSchedule = afterList.find((entry) => {
      return entry.name === "linked-to-thread";
    });
    expect(linkedSchedule).toBeUndefined();

    // Given: another thread with a running run linked to it; a
    // sibling thread with its own running run.
    await seedOrgMetadata(scheduleFixture.orgId);
    const target = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const sibling = await track(
      store.set(
        seedZeroChatThread$,
        { userId: target.userId, orgId: target.orgId },
        context.signal,
      ),
    );
    const { runId: targetRun } = await store.set(
      seedRun$,
      {
        orgId: target.orgId,
        userId: target.userId,
        composeId: target.composeId,
        status: "running",
        chatThreadId: target.threadId,
      },
      context.signal,
    );
    const { runId: siblingRun } = await store.set(
      seedRun$,
      {
        orgId: target.orgId,
        userId: target.userId,
        composeId: sibling.composeId,
        status: "running",
        chatThreadId: sibling.threadId,
      },
      context.signal,
    );
    mocks.clerk.session(target.userId, target.orgId);
    context.mocks.ably.publish.mockClear();

    // When: the owner deletes the target thread.
    await accept(
      c.delete({
        params: { id: target.threadId },
        headers: authHeaders(),
      }),
      [204],
    );

    // Then: the post-cancel side effects land and the target run is
    // cancelled while the sibling run keeps running.
    await clearAllDetached();
    await expect(getRunStatus(targetRun)).resolves.toBe("cancelled");
    await expect(getRunStatus(siblingRun)).resolves.toBe("running");
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `runChanged:${targetRun}`,
      { status: "cancelled" },
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "queue:changed",
      null,
    );
  });
});
