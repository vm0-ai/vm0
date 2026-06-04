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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function activityClient() {
  return setupApp({ context })(zeroMemoryActivityContract);
}

function addedDiff(text: string): MemoryChangeDiff {
  return {
    format: "line",
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

describe("GET /api/zero/memory/activity", () => {
  const track = createFixtureTracker<MemoryFixture>((fixture) => {
    return store.set(deleteMemoryForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(activityClient().get({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      activityClient().get({ headers: authHeaders() }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns an empty timeline when the user has no summaries", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      activityClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ entries: [] });
  });

  it("returns entries most-recent-day first with their items", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
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
            kind: "learned",
            title: "Project uses pnpm",
            description: "Package manager preference",
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
            kind: "updated",
            title: "Project uses pnpm",
            description: null,
            filePath: "preferences/pnpm.md",
            diff: updatedDiff(
              "Use pnpm for all package operations",
              "Use pnpm 9 for all package operations",
            ),
          },
          {
            kind: "forgotten",
            title: null,
            description: null,
            filePath: "notes/stale.md",
            diff: removedDiff("Old note"),
          },
        ],
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      activityClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      entries: [
        {
          date: "2025-05-03",
          summary: null,
          fromVersionId: "v1",
          toVersionId: "v2",
          // Items are ordered by `kind` then `file_path`, so `forgotten`
          // precedes `updated` regardless of the seeded insertion order.
          items: [
            {
              kind: "forgotten",
              title: null,
              description: null,
              filePath: "notes/stale.md",
              diff: removedDiff("Old note"),
            },
            {
              kind: "updated",
              title: "Project uses pnpm",
              description: null,
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
              kind: "learned",
              title: "Project uses pnpm",
              description: "Package manager preference",
              filePath: "preferences/pnpm.md",
              diff: addedDiff("Use pnpm for all package operations"),
            },
          ],
        },
      ],
    });
  });

  it("returns an entry with no items", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    await store.set(
      seedMemoryActivitySummary$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: "2025-06-01",
        toVersionId: "v9",
        summary: "A quiet narrative day",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      activityClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.entries).toStrictEqual([
      {
        date: "2025-06-01",
        summary: "A quiet narrative day",
        fromVersionId: null,
        toVersionId: "v9",
        items: [],
      },
    ]);
  });

  it("orders a summary's items deterministically by kind then file_path", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    // Seeded out of the expected order and with a `file_path`-only order
    // (b, a, d, c) that differs from the kind-then-path order, so a pass
    // can only come from sorting on `kind` first and `file_path` second.
    // All items share one batch-insert `created_at`, mirroring the cron, so
    // the previous `created_at` ordering would leave this order undefined.
    await store.set(
      seedMemoryActivitySummary$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: "2025-07-01",
        toVersionId: "v-order",
        summary: "Many changes in one day",
        items: [
          { kind: "updated", filePath: "b.md" },
          { kind: "learned", filePath: "d.md" },
          { kind: "learned", filePath: "a.md" },
          { kind: "forgotten", filePath: "c.md" },
        ],
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      activityClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(
      response.body.entries[0]?.items.map((item) => {
        return { kind: item.kind, filePath: item.filePath };
      }),
    ).toStrictEqual([
      { kind: "forgotten", filePath: "c.md" },
      { kind: "learned", filePath: "a.md" },
      { kind: "learned", filePath: "d.md" },
      { kind: "updated", filePath: "b.md" },
    ]);
  });

  it("scopes summaries to the authenticated user and org", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    // Same org, different user.
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
            kind: "learned",
            title: "Secret",
            filePath: "secret.md",
            diff: addedDiff("Should not leak"),
          },
        ],
      },
      context.signal,
    );
    // Different org, same user id (must not leak across orgs).
    const otherFixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    await store.set(
      seedMemoryActivitySummary$,
      {
        orgId: otherFixture.orgId,
        userId: fixture.userId,
        date: "2025-05-11",
        toVersionId: "other-org-v1",
        summary: "Other org's memory",
      },
      context.signal,
    );
    // The authenticated user's own summary in their own org.
    await store.set(
      seedMemoryActivitySummary$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        date: "2025-05-12",
        toVersionId: "mine-v1",
        summary: "My memory",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      activityClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.entries).toHaveLength(1);
    expect(response.body.entries[0]).toStrictEqual({
      date: "2025-05-12",
      summary: "My memory",
      fromVersionId: null,
      toVersionId: "mine-v1",
      items: [],
    });
  });
});
