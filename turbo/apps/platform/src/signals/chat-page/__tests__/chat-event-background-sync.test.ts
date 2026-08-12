import { waitFor } from "@testing-library/react";
import type { ChatEventRowV4 } from "@vm0/api-contracts/contracts/chat-event-rows";
import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearMockedAuth,
  mockOrganization,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { CHAT_EVENT_ROWS_STORE } from "../../external/chat-idb-schema.ts";
import { chatIdb$ } from "../../external/chat-idb-store.ts";
import { setupRealtime$ } from "../../realtime.ts";
import { resetSignal } from "../../utils.ts";
import { writeIndexedDbChatEventRows$ } from "../chat-event-row-indexed-db.ts";
import { setupChatEventBackgroundSync$ } from "../chat-event-background-sync.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const resetSubscriberSignal$ = resetSignal();

const USER_ID = "background-sync-user";
const ORG_ID = "background-sync-org";
const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000805";
const THIRD_THREAD_ID = "b0000000-0000-4000-a000-000000000809";
const FIRST_CACHED_EVENT_ID = "00000000-0000-4000-8000-000000000802";
const LAST_CACHED_EVENT_ID = "00000000-0000-4000-8000-000000000803";
const NEW_EVENT_ID = "00000000-0000-4000-8000-000000000804";

function assistantRow(
  threadId: string,
  id: string,
  content: string,
  createdAt: string,
  seqId: number,
): ChatEventRowV4 {
  return {
    id,
    chatThreadId: threadId,
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: { content },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt,
  };
}

const firstCachedRow = assistantRow(
  THREAD_ID,
  FIRST_CACHED_EVENT_ID,
  "First cached message",
  "2026-07-23T10:01:00.000Z",
  1,
);
const lastCachedRow = assistantRow(
  THREAD_ID,
  LAST_CACHED_EVENT_ID,
  "Last cached message",
  "2026-07-23T10:02:00.000Z",
  2,
);
const newRow = assistantRow(
  THREAD_ID,
  NEW_EVENT_ID,
  "New remote message",
  "2026-07-23T10:03:00.000Z",
  3,
);

function mockSignedInUser(): void {
  mockUser(
    {
      id: USER_ID,
      fullName: "Background Sync User",
      email: "background-sync@example.com",
    },
    { token: "test-token" },
  );
  mockOrganization({
    activeOrg: { id: ORG_ID, name: "Background Sync Org" },
    memberships: [{ id: ORG_ID }],
  });
}

async function setupAuthenticatedBackgroundSync(): Promise<void> {
  await setupPage({
    context,
    path: "/error",
    withoutRender: true,
    user: {
      id: USER_ID,
      fullName: "Background Sync User",
      email: "background-sync@example.com",
    },
    session: { token: "test-token" },
    org: {
      activeOrg: { id: ORG_ID, name: "Background Sync Org" },
      memberships: [{ id: ORG_ID }],
    },
    featureSwitches: { [FeatureSwitchKey.UnifiedIndicatorApi]: true },
  });
}

function mockMissingSnapshots(): void {
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(404, {
      error: {
        message: "Chat event snapshot not found",
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
      },
    });
  });
}

describe("chat event background sync", () => {
  afterEach(() => {
    clearMockedAuth();
  });

  it("subscribes while prefetching unread and active threads once", async () => {
    const initialThreadIdsReady = context.mocks.deferred<void>();
    const requestedThreadIds: string[] = [];
    let indicatorRequests = 0;

    context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
      indicatorRequests += 1;
      await initialThreadIdsReady.promise;
      return respond(200, {
        agents: {},
        threads: {
          [THREAD_ID]: "unread",
          [OTHER_THREAD_ID]: "active",
          [THIRD_THREAD_ID]: "active",
        },
      });
    });
    mockMissingSnapshots();
    context.mocks.api(chatThreadEventsContract.rows, ({ params, respond }) => {
      requestedThreadIds.push(params.threadId);
      return respond(200, { rows: [] });
    });

    await setupAuthenticatedBackgroundSync();

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });

    expect(requestedThreadIds).toStrictEqual([]);
    initialThreadIdsReady.resolve();

    await waitFor(() => {
      expect(requestedThreadIds).toHaveLength(3);
    });
    expect(indicatorRequests).toBe(1);
    expect(new Set(requestedThreadIds)).toStrictEqual(
      new Set([THREAD_ID, OTHER_THREAD_ID, THIRD_THREAD_ID]),
    );
  });

  it("catches up only unread threads after reconnect", async () => {
    const requestedThreadIds: string[] = [];
    let unreadThreadIds = [THREAD_ID];
    let indicatorRequests = 0;

    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      indicatorRequests += 1;
      return respond(200, {
        agents: {},
        threads: Object.fromEntries([
          ...unreadThreadIds.map((threadId) => {
            return [threadId, "unread" as const];
          }),
          [OTHER_THREAD_ID, "active" as const],
        ]),
      });
    });
    mockMissingSnapshots();
    context.mocks.api(chatThreadEventsContract.rows, ({ params, respond }) => {
      requestedThreadIds.push(params.threadId);
      return respond(200, { rows: [] });
    });

    await setupAuthenticatedBackgroundSync();

    await waitFor(() => {
      expect(new Set(requestedThreadIds)).toStrictEqual(
        new Set([THREAD_ID, OTHER_THREAD_ID]),
      );
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    requestedThreadIds.length = 0;
    unreadThreadIds = [THIRD_THREAD_ID];

    context.mocks.ably.triggerReconnect();

    await waitFor(() => {
      expect(indicatorRequests).toBe(2);
      expect(requestedThreadIds).toStrictEqual([THIRD_THREAD_ID]);
    });
  });

  it("fills only rows after the cached thread end", async () => {
    mockSignedInUser();
    const appDb = await context.store.get(chatIdb$);
    await context.store.set(
      writeIndexedDbChatEventRows$,
      [firstCachedRow, lastCachedRow],
      context.signal,
    );

    const cursors: number[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      cursors.push(query.sinceSeqId);
      if (query.sinceSeqId === lastCachedRow.seqId) {
        return respond(200, { rows: [newRow] });
      }
      throw new Error(`Unexpected row cursor: ${JSON.stringify(query)}`);
    });

    await context.store.set(setupRealtime$, context.signal);
    const subscriberSignal = context.store.set(
      resetSubscriberSignal$,
      context.signal,
    );
    const subscription = context.store.set(
      setupChatEventBackgroundSync$,
      subscriberSignal,
    );

    try {
      await waitFor(() => {
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
      });

      context.mocks.ably.trigger("threadListChanged");
      context.mocks.ably.trigger(`chatThreadMessageCreated:${THREAD_ID}`);

      await waitFor(async () => {
        await expect(
          appDb.get(CHAT_EVENT_ROWS_STORE, NEW_EVENT_ID),
        ).resolves.toMatchObject({
          id: NEW_EVENT_ID,
          chatThreadId: THREAD_ID,
        });
      });

      expect(cursors).toStrictEqual([2]);
    } finally {
      context.store.set(resetSubscriberSignal$, context.signal);
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
      appDb.close();
    }
  });

  it("skips a delayed created event whose sequence is already cached", async () => {
    mockSignedInUser();
    const appDb = await context.store.get(chatIdb$);
    await context.store.set(
      writeIndexedDbChatEventRows$,
      [firstCachedRow, lastCachedRow],
      context.signal,
    );

    let cachedThreadRequests = 0;
    const otherThreadRequested = context.mocks.deferred<void>();
    mockMissingSnapshots();
    context.mocks.api(chatThreadEventsContract.rows, ({ params, respond }) => {
      if (params.threadId === THREAD_ID) {
        cachedThreadRequests += 1;
      }
      if (params.threadId === OTHER_THREAD_ID) {
        otherThreadRequested.resolve();
      }
      return respond(200, { rows: [] });
    });

    await context.store.set(setupRealtime$, context.signal);
    const subscriberSignal = context.store.set(
      resetSubscriberSignal$,
      context.signal,
    );
    const subscription = context.store.set(
      setupChatEventBackgroundSync$,
      subscriberSignal,
    );

    try {
      await waitFor(() => {
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
      });

      context.mocks.ably.trigger(`chatThreadMessageCreated:${THREAD_ID}`, {
        syncThroughSeqId: lastCachedRow.seqId,
      });
      context.mocks.ably.trigger(`chatThreadMessageCreated:${OTHER_THREAD_ID}`);

      await otherThreadRequested.promise;
      expect(cachedThreadRequests).toBe(0);
    } finally {
      context.store.set(resetSubscriberSignal$, context.signal);
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
      appDb.close();
    }
  });
});
