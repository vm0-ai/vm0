import { randomUUID } from "node:crypto";

import { zeroMemoryActivityContract } from "@vm0/api-contracts/contracts/zero-memory-activity";
import type { MemoryChangeDiff } from "@vm0/db/schema/memory-change-item";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteMemoryForFixture$,
  type MemoryFixture,
  seedMemoryActivitySummary$,
  seedMemoryFixture$,
} from "./helpers/zero-memory";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-memory-activity.test.ts`. The Given
// seeds activity summaries through the existing helper — recorded under
// "Open Helper Gaps" in `api.bdd.md` (no public route creates these
// precomputed summaries; they are produced by a cron job). The Then
// step is always through the public GET contract.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroMemoryActivityContract);
}

function addedDiff(text: string): MemoryChangeDiff {
  return {
    format: "line",
    beforeExists: false,
    afterExists: true,
    truncated: false,
    stats: { added: 1, removed: 0 },
    hunks: [
      {
        beforeStartLine: null,
        afterStartLine: 1,
        lines: [{ op: "add", beforeLine: null, afterLine: 1, text }],
      },
    ],
  };
}

function removedDiff(text: string): MemoryChangeDiff {
  return {
    format: "line",
    beforeExists: true,
    afterExists: false,
    truncated: false,
    stats: { added: 0, removed: 1 },
    hunks: [
      {
        beforeStartLine: 1,
        afterStartLine: null,
        lines: [{ op: "remove", beforeLine: 1, afterLine: null, text }],
      },
    ],
  };
}

function updatedDiff(beforeText: string, afterText: string): MemoryChangeDiff {
  return {
    format: "line",
    beforeExists: true,
    afterExists: true,
    truncated: false,
    stats: { added: 1, removed: 1 },
    hunks: [
      {
        beforeStartLine: 1,
        afterStartLine: 1,
        lines: [
          { op: "remove", beforeLine: 1, afterLine: null, text: beforeText },
          { op: "add", beforeLine: null, afterLine: 1, text: afterText },
        ],
      },
    ],
  };
}

const track = createFixtureTracker<MemoryFixture>((fixture) => {
  return store.set(deleteMemoryForFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/memory/activity — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(c.get({ headers: {} }), [401]);
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // When + Then: session without an org → 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(c.get({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/zero/memory/activity — timeline chain", () => {
  it("gwt-wt-wt: empty → populated (most-recent-first, item-ordering) → scope isolation", async () => {
    const c = client();

    // Given: a fresh user with no summaries.
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: the timeline is empty.
    const empty = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(empty.body).toStrictEqual({ entries: [], nextCursor: null });

    // Given: three summaries spanning two non-consecutive days with mixed
    // item counts. The 2025-05-04 row has no items and is expected to be
    // omitted entirely.
    await store.set(
      seedMemoryActivitySummary$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: "2025-05-01",
        fromVersionId: null,
        toVersionId: "v1",
        summary: "Zero learned about your project setup",
        items: [
          {
            filePath: "preferences/pnpm.md",
            diff: addedDiff("Use pnpm for all package operations"),
          },
        ],
      },
      context.signal,
    );
    await store.set(
      seedMemoryActivitySummary$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: "2025-05-03",
        fromVersionId: "v1",
        toVersionId: "v2",
        summary: null,
        items: [
          {
            filePath: "preferences/pnpm.md",
            diff: updatedDiff(
              "Use pnpm for all package operations",
              "Use pnpm 9 for all package operations",
            ),
          },
          {
            filePath: "notes/stale.md",
            diff: removedDiff("Old note"),
          },
        ],
      },
      context.signal,
    );
    await store.set(
      seedMemoryActivitySummary$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: "2025-05-04",
        fromVersionId: "v2",
        toVersionId: "v3",
        summary: null,
      },
      context.signal,
    );

    // When + Then: ordering is most-recent-day first; items inside a
    // summary are sorted by file_path (so notes/stale.md comes before
    // preferences/pnpm.md on 2025-05-03); entries with no items are
    // dropped.
    const populated = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(populated.body).toStrictEqual({
      entries: [
        {
          date: "2025-05-03",
          summary: null,
          fromVersionId: "v1",
          toVersionId: "v2",
          items: [
            {
              filePath: "notes/stale.md",
              diff: removedDiff("Old note"),
            },
            {
              filePath: "preferences/pnpm.md",
              diff: updatedDiff(
                "Use pnpm for all package operations",
                "Use pnpm 9 for all package operations",
              ),
            },
          ],
        },
        {
          date: "2025-05-01",
          summary: "Zero learned about your project setup",
          fromVersionId: null,
          toVersionId: "v1",
          items: [
            {
              filePath: "preferences/pnpm.md",
              diff: addedDiff("Use pnpm for all package operations"),
            },
          ],
        },
      ],
      nextCursor: null,
    });

    // Given: a same-org different-user summary, and a same-user
    // different-org summary — both must not leak into the response.
    const otherUserId = `user_${randomUUID()}`;
    await store.set(
      seedMemoryActivitySummary$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        date: "2025-05-10",
        toVersionId: "other-user-v1",
        summary: "Other user's memory",
        items: [
          {
            filePath: "secret.md",
            diff: addedDiff("Should not leak"),
          },
        ],
      },
      context.signal,
    );
    const otherOrgFixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    await store.set(
      seedMemoryActivitySummary$,
      {
        orgId: otherOrgFixture.orgId,
        userId: fixture.userId,
        date: "2025-05-11",
        toVersionId: "other-org-v1",
        summary: "Other org's memory",
      },
      context.signal,
    );

    // When + Then: only the caller's own summaries appear.
    const scoped = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(scoped.body.entries).toHaveLength(2);
    expect(
      scoped.body.entries.map((entry) => {
        return entry.date;
      }),
    ).toStrictEqual(["2025-05-03", "2025-05-01"]);
  });
});

describe("BDD GET /api/zero/memory/activity — pagination chain", () => {
  it("gwt-wt-wt: limit=1 first page → cursor second page → no more", async () => {
    const c = client();

    // Given: four summaries across four days (two have items, two don't
    // — those act as natural cursor stops).
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    for (const date of ["2025-05-01", "2025-05-03"]) {
      await store.set(
        seedMemoryActivitySummary$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          date,
          toVersionId: `v-${date}`,
          summary: `Summary for ${date}`,
          items: [
            {
              filePath: `${date}.md`,
              diff: addedDiff(date),
            },
          ],
        },
        context.signal,
      );
    }
    for (const date of ["2025-05-02", "2025-05-04"]) {
      await store.set(
        seedMemoryActivitySummary$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          date,
          toVersionId: `empty-${date}`,
          summary: `Empty summary for ${date}`,
        },
        context.signal,
      );
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: limit=1 returns the most recent entry with items
    // (2025-05-03) and exposes a cursor for the next page.
    const firstPage = await accept(
      c.get({ headers: authHeaders(), query: { limit: 1 } }),
      [200],
    );
    expect(
      firstPage.body.entries.map((entry) => {
        return entry.date;
      }),
    ).toStrictEqual(["2025-05-03"]);
    expect(firstPage.body.entries[0]?.items).toStrictEqual([
      {
        filePath: "2025-05-03.md",
        diff: addedDiff("2025-05-03"),
      },
    ]);
    expect(firstPage.body.nextCursor).toBe("2025-05-03");

    // When + Then: the cursor lands on the next page; the nextCursor
    // is null because there are no more summaries with items.
    const secondPage = await accept(
      c.get({
        headers: authHeaders(),
        query: { limit: 1, cursor: firstPage.body.nextCursor ?? "" },
      }),
      [200],
    );
    expect(
      secondPage.body.entries.map((entry) => {
        return entry.date;
      }),
    ).toStrictEqual(["2025-05-01"]);
    expect(secondPage.body.entries[0]?.items).toStrictEqual([
      {
        filePath: "2025-05-01.md",
        diff: addedDiff("2025-05-01"),
      },
    ]);
    expect(secondPage.body.nextCursor).toBeNull();
  });
});
