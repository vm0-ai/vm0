import { randomUUID } from "node:crypto";

import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { nowDate } from "../../external/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteZeroChatThread$,
  seedZeroChatMessage$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import { seedRun$ } from "./helpers/zero-usage-insight";

// BDD migration of the legacy `zero-chat-threads-list.test.ts`.
// The legacy direct DB UPDATE/SELECTs that verified ordering and
// pinning side-effects are replaced by re-listing through the
// public contract. The 29 legacy `it()`s collapse into 5 BDD
// `it()`s (auth boundary + scoped list + org-wide list +
// pagination + read-state/runs/schedules chain).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function listClient() {
  return setupApp({ context })(chatThreadsContract);
}

function allListedThreads<U>(body: {
  pinned: readonly U[];
  threads: readonly U[];
}): readonly U[] {
  return [...body.pinned, ...body.threads];
}

const track = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});

describe("BDD GET /api/zero/chat-threads — auth boundary", () => {
  it("returns 401 when not authenticated and when the session has no organization", async () => {
    // When + Then: no auth header → 401.
    const noAuth = await accept(
      listClient().list({ query: {}, headers: {} }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      listClient().list({ query: {}, headers: authHeaders() }),
      [401],
    );
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("BDD GET /api/zero/chat-threads — scoped list chain", () => {
  it("gwt-wt-wt: 404 compose from different org when agentId scoped → 200 empty (no threads) → 200 with id/createdAt/updatedAt fields → 200 isRead=true (no messages) → 200 isRead based on lastReadMessageId", async () => {
    const c = listClient();

    // Given: a session + an agent compose from a different org
    // (scoped via agentId).
    const otherOrgFixture = await track(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    const callerUserId = `user_${randomUUID()}`;
    const callerOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(callerUserId, callerOrgId);

    // When + Then: 404 because the compose is not in the caller's
    // org.
    const crossOrgCompose = await accept(
      c.list({
        query: { agentId: otherOrgFixture.composeId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossOrgCompose.body.error.code).toBe("NOT_FOUND");

    // Given: a fresh user/org with no threads.
    const emptyUserId = `user_${randomUUID()}`;
    const emptyOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(emptyUserId, emptyOrgId);

    // When + Then: empty list.
    const empty = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(allListedThreads(empty.body)).toStrictEqual([]);

    // Given: a single thread for an empty agent.
    const idFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: emptyUserId, orgId: emptyOrgId, title: "id-fields" },
        context.signal,
      ),
    );
    mocks.clerk.session(emptyUserId, emptyOrgId);

    // When + Then: the list row (scoped by agentId) carries id,
    // createdAt, updatedAt and reports isRead=true (no messages).
    const idRow = await accept(
      c.list({
        query: { agentId: idFixture.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(allListedThreads(idRow.body)).toHaveLength(1);
    const idEntry = allListedThreads(idRow.body)[0]!;
    expect(idEntry.id).toBe(idFixture.threadId);
    expect(idEntry.title).toBe("id-fields");
    expect(typeof idEntry.createdAt).toBe("string");
    expect(typeof idEntry.updatedAt).toBe("string");
    expect(idEntry.isRead).toBeTruthy();

    // Given: a thread with two messages; the first is marked
    // read. Public surface cannot produce lastReadMessageId
    // without a public API, so a direct DB update is the only
    // precondition.
    const readFixture = await track(
      store.set(seedZeroChatThread$, { title: "isRead" }, context.signal),
    );
    const msg1Id = await store.set(
      seedZeroChatMessage$,
      readFixture,
      {
        role: "user",
        content: "first",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      seedZeroChatMessage$,
      readFixture,
      {
        role: "assistant",
        content: "second",
        createdAt: new Date("2025-01-01T00:00:01.000Z"),
      },
      context.signal,
    );
    await store
      .set(writeDb$)
      .update(chatThreads)
      .set({ lastReadMessageId: msg1Id })
      .where(eq(chatThreads.id, readFixture.threadId));
    mocks.clerk.session(readFixture.userId, readFixture.orgId);

    // When + Then: isRead is false (we haven't read past the first
    // message yet).
    const unread = await accept(
      c.list({
        query: { agentId: readFixture.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(unread.body.threads[0]?.isRead).toBeFalsy();
  });
});

describe("BDD GET /api/zero/chat-threads — ordering chain", () => {
  it("gwt-wt-wt: 200 orders by latest message createdAt desc → 200 orders empty threads by own createdAt desc → 200 pinned threads float to top → 200 agent.id and agent.avatarUrl populated when scoped", async () => {
    const c = listClient();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;

    // Given: two threads with messages at different times.
    const olderFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "older" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      olderFixture,
      {
        role: "user",
        content: "older msg",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      context.signal,
    );
    const newerFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "newer" },
        context.signal,
      ),
    );
    await store.set(
      seedZeroChatMessage$,
      newerFixture,
      {
        role: "user",
        content: "newer msg",
        createdAt: new Date("2025-01-02T00:00:00.000Z"),
      },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: the list orders threads by the latest message's
    // createdAt desc (newer first).
    const ordered = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(
      allListedThreads(ordered.body).map((t) => {
        return t.id;
      }),
    ).toStrictEqual([newerFixture.threadId, olderFixture.threadId]);

    // Given: two empty threads with different createdAt (no
    // messages → ordering by own createdAt desc).
    const firstFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "First",
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        },
        context.signal,
      ),
    );
    const secondFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "Second",
          createdAt: new Date("2025-01-02T00:00:00.000Z"),
        },
        context.signal,
      ),
    );

    // When + Then: empty threads are ordered by their own createdAt
    // desc.
    const emptyOrdered = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    const orderedIds = allListedThreads(emptyOrdered.body).map((t) => {
      return t.id;
    });
    expect(orderedIds.indexOf(secondFixture.threadId)).toBeLessThan(
      orderedIds.indexOf(firstFixture.threadId),
    );

    // Given: a third thread with newer createdAt.
    const thirdFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "Third",
          createdAt: new Date("2025-01-03T00:00:00.000Z"),
        },
        context.signal,
      ),
    );

    // When + Then: the baseline order is third → second → first.
    const baseline = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    const baseIds = allListedThreads(baseline.body).map((t) => {
      return t.id;
    });
    expect(baseIds.indexOf(thirdFixture.threadId)).toBeLessThan(
      baseIds.indexOf(secondFixture.threadId),
    );
    expect(baseIds.indexOf(secondFixture.threadId)).toBeLessThan(
      baseIds.indexOf(firstFixture.threadId),
    );

    // Given: the middle thread is now pinned. Public surface has
    // pin/unpin routes; this is a precondition for the next GET
    // rather than a verification step.
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(chatThreads)
      .set({ pinnedAt: nowDate() })
      .where(eq(chatThreads.id, secondFixture.threadId));

    // When + Then: the pinned thread floats to the top.
    const afterPin = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    const pinnedIds = allListedThreads(afterPin.body).map((t) => {
      return t.id;
    });
    expect(pinnedIds[0]).toBe(secondFixture.threadId);

    // When + Then: scoping via `agentId` returns `agent.id` and
    // `agent.avatarUrl` for the scoped compose.
    const scoped = await accept(
      c.list({
        query: { agentId: thirdFixture.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(scoped.body.threads).toHaveLength(1);
    const scopedRow = scoped.body.threads[0]!;
    expect(scopedRow.agent.id).toBe(thirdFixture.composeId);
    expect(scopedRow.agent).toHaveProperty("avatarUrl");
  });
});

describe("BDD GET /api/zero/chat-threads — org-wide list chain", () => {
  it("gwt-wt-wt: 200 returns threads for every agent in caller's org → 200 agent.id and agent.avatarUrl for every row → 200 does not leak threads from another org → 200 pinned threads in `pinned` and non-pinned in `threads` → 200 scoped pinned to requested agent → 200 caps non-pinned at `limit` (hasMore + nextCursor) → 200 second page (no pinned, hasMore false)", async () => {
    const c = listClient();

    // Given: a user with two threads on two different agents.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const a = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "A thread" },
        context.signal,
      ),
    );
    const b = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "B thread" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: the list contains both threads.
    const response = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    const ids = allListedThreads(response.body).map((t) => {
      return t.id;
    });
    expect(ids).toContain(a.threadId);
    expect(ids).toContain(b.threadId);

    // And: every row carries `agent.id` and `agent.avatarUrl`.
    for (const row of allListedThreads(response.body)) {
      expect(row.agent.id).toStrictEqual(expect.any(String));
      expect(row.agent).toHaveProperty("avatarUrl");
    }

    // Given: another user on a different org has a thread.
    const myOrgId = `org_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;
    const mine = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId: myOrgId, title: "Mine" },
        context.signal,
      ),
    );
    const others = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId: otherOrgId, title: "Other" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, myOrgId);

    // When + Then: the caller's list contains `mine` but not
    // `others` (no org leak).
    const scoped = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    const scopedIds = allListedThreads(scoped.body).map((t) => {
      return t.id;
    });
    expect(scopedIds).toContain(mine.threadId);
    expect(scopedIds).not.toContain(others.threadId);

    // Given: a pinned and an unpinned thread in a fresh org
    // (so previous fixtures don't pollute the result).
    const segUserId = `user_${randomUUID()}`;
    const segOrgId = `org_${randomUUID()}`;
    const pinnedFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: segUserId, orgId: segOrgId, title: "Pinned" },
        context.signal,
      ),
    );
    const unpinnedFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId: segUserId, orgId: segOrgId, title: "Unpinned" },
        context.signal,
      ),
    );
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(chatThreads)
      .set({ pinnedAt: nowDate() })
      .where(eq(chatThreads.id, pinnedFixture.threadId));
    mocks.clerk.session(segUserId, segOrgId);

    // When + Then: pinned shows up in `pinned`, unpinned in
    // `threads`, with totalCount/hasMore/nextCursor defaults.
    const segmented = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(
      segmented.body.pinned.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([pinnedFixture.threadId]);
    expect(
      segmented.body.threads.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([unpinnedFixture.threadId]);
    expect(segmented.body.totalCount).toBe(1);
    expect(segmented.body.hasMore).toBeFalsy();
    expect(segmented.body.nextCursor).toBeNull();

    // Given: two pinned threads on different agents + an
    // unpinned one in a fresh userId/orgId.
    const scopeUserId = `user_${randomUUID()}`;
    const scopeOrgId = `org_${randomUUID()}`;
    const scopedPinned = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId: scopeUserId,
          orgId: scopeOrgId,
          title: "Scoped pinned",
          pinnedAt: new Date("2025-05-02T10:00:00.000Z"),
        },
        context.signal,
      ),
    );
    const otherPinnedFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId: scopeUserId,
          orgId: scopeOrgId,
          title: "Pinned from another agent",
          pinnedAt: new Date("2025-05-01T10:00:00.000Z"),
        },
        context.signal,
      ),
    );
    const otherUnpinnedFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId: scopeUserId,
          orgId: scopeOrgId,
          title: "Other unpinned",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(scopeUserId, scopeOrgId);

    // When + Then: scoping by `agentId` returns only the pinned
    // thread for that agent.
    const agentScoped = await accept(
      c.list({
        query: { agentId: scopedPinned.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(
      agentScoped.body.pinned.map((t) => {
        return t.id;
      }),
    ).toStrictEqual([scopedPinned.threadId]);
    expect(agentScoped.body.threads).toStrictEqual([]);
    const agentScopedIds = allListedThreads(agentScoped.body).map((t) => {
      return t.id;
    });
    expect(agentScopedIds).not.toContain(otherPinnedFixture.threadId);
    expect(agentScopedIds).not.toContain(otherUnpinnedFixture.threadId);
    expect(agentScoped.body.totalCount).toBe(0);

    // Given: 3 non-pinned threads with distinct createdAt in yet
    // another fresh userId/orgId.
    const pageUserId = `user_${randomUUID()}`;
    const pageOrgId = `org_${randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      await track(
        store.set(
          seedZeroChatThread$,
          {
            userId: pageUserId,
            orgId: pageOrgId,
            title: `T${i}`,
            createdAt: new Date(`2025-02-0${i + 1}T00:00:00.000Z`),
          },
          context.signal,
        ),
      );
    }
    mocks.clerk.session(pageUserId, pageOrgId);

    // When + Then: the first page has 2 threads, hasMore is
    // true, nextCursor is set, totalCount is 3.
    const firstPage = await accept(
      c.list({ query: { limit: 2 }, headers: authHeaders() }),
      [200],
    );
    expect(firstPage.body.threads).toHaveLength(2);
    expect(firstPage.body.hasMore).toBeTruthy();
    expect(firstPage.body.nextCursor).not.toBeNull();
    expect(firstPage.body.totalCount).toBe(3);

    // And: the second page (using nextCursor) has the remaining
    // 1 thread, hasMore is false, nextCursor is null, and the
    // pinned segment is omitted on cursor pages.
    const secondPage = await accept(
      c.list({
        query: { limit: 2, cursor: firstPage.body.nextCursor! },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(secondPage.body.threads).toHaveLength(1);
    expect(secondPage.body.hasMore).toBeFalsy();
    expect(secondPage.body.nextCursor).toBeNull();
    expect(secondPage.body.pinned).toStrictEqual([]);

    // And: the union of both pages is 3 distinct thread ids.
    const allIds = [
      ...firstPage.body.threads.map((t) => {
        return t.id;
      }),
      ...secondPage.body.threads.map((t) => {
        return t.id;
      }),
    ];
    expect(new Set(allIds).size).toBe(3);
  });
});

describe("BDD GET /api/zero/chat-threads — running + hasDraft + scheduleCount chain", () => {
  it("gwt-wt-wt: 200 running=false (no runs) → 200 running=true (non-terminal run) → 200 running=false (all terminal) → 200 running=true (mixed: any non-terminal) → 200 hasDraft=false (no draft) → 200 hasDraft=true (draftContent) → 200 hasDraft=true (only draftAttachments) → 200 hasDraft=false (empty draftContent) → 200 scheduleCount per thread", async () => {
    const c = listClient();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;

    // Given: a thread with no runs.
    const noRuns = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "no runs" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: running=false.
    const noRunsRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === noRuns.threadId;
    });
    expect(noRunsRow?.running).toBeFalsy();

    // Given: a thread with a non-terminal (running) run.
    const runningFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "running" },
        context.signal,
      ),
    );
    const { runId: activeRunId } = await store.set(
      seedRun$,
      {
        orgId,
        userId,
        composeId: runningFixture.composeId,
        status: "running",
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId,
        userId,
        composeId: runningFixture.composeId,
        status: "completed",
      },
      context.signal,
    );
    // Link activeRunId to the running fixture so the list
    // surfaces it as non-terminal.
    const { addRunToThread$ } = await import("./helpers/zero-chat-threads");
    await store.set(
      addRunToThread$,
      { threadId: runningFixture.threadId, runId: activeRunId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: running=true.
    const runningRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === runningFixture.threadId;
    });
    expect(runningRow?.running).toBeTruthy();

    // Given: a thread with only a completed run.
    const completedFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "all terminal" },
        context.signal,
      ),
    );
    const { runId: completedRunId } = await store.set(
      seedRun$,
      {
        orgId,
        userId,
        composeId: completedFixture.composeId,
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: completedFixture.threadId, runId: completedRunId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: running=false.
    const completedRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === completedFixture.threadId;
    });
    expect(completedRow?.running).toBeFalsy();

    // Given: a thread with both a non-terminal and a terminal
    // run (mixed: the non-terminal wins).
    const mixedFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "mixed runs" },
        context.signal,
      ),
    );
    const { runId: mixedActiveId } = await store.set(
      seedRun$,
      {
        orgId,
        userId,
        composeId: mixedFixture.composeId,
        status: "running",
      },
      context.signal,
    );
    const { runId: mixedDoneId } = await store.set(
      seedRun$,
      {
        orgId,
        userId,
        composeId: mixedFixture.composeId,
        status: "completed",
      },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: mixedFixture.threadId, runId: mixedActiveId },
      context.signal,
    );
    await store.set(
      addRunToThread$,
      { threadId: mixedFixture.threadId, runId: mixedDoneId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: running=true (any non-terminal wins).
    const mixedRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === mixedFixture.threadId;
    });
    expect(mixedRow?.running).toBeTruthy();

    // Given: a thread with no draft.
    const noDraft = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "no draft" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: hasDraft=false.
    const noDraftRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === noDraft.threadId;
    });
    expect(noDraftRow?.hasDraft).toBeFalsy();

    // Given: a thread with draftContent set.
    const draftFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "with draft",
          draftContent: "in-progress prompt",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: hasDraft=true.
    const draftRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === draftFixture.threadId;
    });
    expect(draftRow?.hasDraft).toBeTruthy();

    // Given: a thread with only draftAttachments set.
    const attachDraftFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "with attach draft",
          draftContent: null,
          draftAttachments: [
            {
              id: "draft-attach-1",
              url: "https://cdn.vm7.io/artifacts/.../a.txt",
              filename: "a.txt",
              contentType: "text/plain",
              size: 10,
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: hasDraft=true.
    const attachDraftRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === attachDraftFixture.threadId;
    });
    expect(attachDraftRow?.hasDraft).toBeTruthy();

    // Given: a thread with an empty draftContent string.
    const emptyDraftFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "empty draft",
          draftContent: "",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: hasDraft=false (empty string is "no draft").
    const emptyDraftRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === emptyDraftFixture.threadId;
    });
    expect(emptyDraftRow?.hasDraft).toBeFalsy();

    // Given: a thread with two linked schedules.
    const scheduleFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "schedules" },
        context.signal,
      ),
    );
    const writeDb = store.set(writeDb$);
    await writeDb.insert(zeroAgentSchedules).values([
      {
        agentId: scheduleFixture.composeId,
        userId,
        orgId,
        name: "sched-1",
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        prompt: "a",
        timezone: "UTC",
        chatThreadId: scheduleFixture.threadId,
      },
      {
        agentId: scheduleFixture.composeId,
        userId,
        orgId,
        name: "sched-2",
        triggerType: "cron",
        cronExpression: "0 10 * * *",
        prompt: "b",
        timezone: "UTC",
        chatThreadId: scheduleFixture.threadId,
      },
    ]);
    mocks.clerk.session(userId, orgId);

    // When + Then: scheduleCount is 2 for the scheduleFixture
    // thread.
    const scheduleRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === scheduleFixture.threadId;
    });
    expect(scheduleRow?.scheduleCount).toBe(2);
  });
});

describe("BDD GET /api/zero/chat-threads — pinnedAt + renamedAt shape chain", () => {
  it("gwt-wt-wt: 200 pinnedAt and renamedAt ISO strings when set → 200 pinnedAt and renamedAt null when not set → 200 pinned threads come before unpinned threads", async () => {
    const c = listClient();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;

    // Given: a thread with pinnedAt + renamedAt set.
    const stampedFixture = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "stamped",
          pinnedAt: new Date("2025-04-01T00:00:00.000Z"),
          renamedAt: new Date("2025-04-02T00:00:00.000Z"),
        },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: pinnedAt and renamedAt are ISO strings. The
    // thread is in the `pinned` segment because pinnedAt is set.
    const stampedBody = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body;
    const stampedRow =
      stampedBody.pinned.find((t) => {
        return t.id === stampedFixture.threadId;
      }) ??
      stampedBody.threads.find((t) => {
        return t.id === stampedFixture.threadId;
      });
    expect(stampedRow).toBeDefined();
    expect(stampedRow?.pinnedAt).toBe("2025-04-01T00:00:00.000Z");
    expect(stampedRow?.renamedAt).toBe("2025-04-02T00:00:00.000Z");

    // Given: a thread with neither set.
    const unstampedFixture = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "unstamped" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: pinnedAt and renamedAt are null.
    const unstampedRow = (
      await accept(c.list({ query: {}, headers: authHeaders() }), [200])
    ).body.threads.find((t) => {
      return t.id === unstampedFixture.threadId;
    });
    expect(unstampedRow?.pinnedAt).toBeNull();
    expect(unstampedRow?.renamedAt).toBeNull();

    // Given: a pinned thread and an unpinned thread.
    const pinnedA = await track(
      store.set(
        seedZeroChatThread$,
        {
          userId,
          orgId,
          title: "Pinned A",
          pinnedAt: new Date("2025-05-01T00:00:00.000Z"),
        },
        context.signal,
      ),
    );
    const unpinnedA = await track(
      store.set(
        seedZeroChatThread$,
        { userId, orgId, title: "Unpinned A" },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId);

    // When + Then: the pinned thread shows up in `pinned` and the
    // unpinned one in `threads`.
    const segmented = await accept(
      c.list({ query: {}, headers: authHeaders() }),
      [200],
    );
    const pinnedIds = segmented.body.pinned.map((t) => {
      return t.id;
    });
    const threadIds = segmented.body.threads.map((t) => {
      return t.id;
    });
    expect(pinnedIds).toContain(pinnedA.threadId);
    expect(threadIds).toContain(unpinnedA.threadId);
    expect(pinnedIds).not.toContain(unpinnedA.threadId);
    expect(threadIds).not.toContain(pinnedA.threadId);
  });
});
