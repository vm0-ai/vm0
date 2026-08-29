import { waitFor } from "@testing-library/react";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it, vi } from "vitest";

import { setupBootstrap, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../__tests__/test-helpers.ts";
import { CHAT_EVENT_ROWS_STORE } from "../../external/chat-idb-schema.ts";
import { chatIdb$ } from "../../external/chat-idb-store.ts";
import { setupRealtime$ } from "../../realtime.ts";
import { resetSignal } from "../../utils.ts";
import { createChatEventSignals } from "../chat-event-signals.ts";
import { writeIndexedDbChatEventRows$ } from "../chat-event-row-indexed-db.ts";
import { setupChatEventBackgroundSync$ } from "../chat-event-background-sync.ts";
import {
  setCurrentLeftPane$,
  setCurrentRightPane$,
} from "../chat-thread-pane-state.ts";
import { createChatPanelSignals } from "../create-chat-thread.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const resetSubscriberSignal$ = resetSignal();

const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000805";
const THIRD_THREAD_ID = "b0000000-0000-4000-a000-000000000809";
const FIRST_TEN_UNREAD_THREAD_IDS = Array.from({ length: 10 }, (_, index) => {
  return `c0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`;
});
const OPEN_UNREAD_THREAD_ID = "c0000000-0000-4000-a000-000000000001";
const ELEVENTH_UNREAD_THREAD_ID = "c0000000-0000-4000-a000-000000000011";
const FIRST_CACHED_EVENT_ID = "00000000-0000-4000-8000-000000000802";
const LAST_CACHED_EVENT_ID = "00000000-0000-4000-8000-000000000803";
const NEW_EVENT_ID = "00000000-0000-4000-8000-000000000804";

function userId(): string {
  return `background-sync-user-${context.resourceId}`;
}

function orgId(): string {
  return `background-sync-org-${context.resourceId}`;
}

async function openTestChatDb() {
  const db = await context.store.get(chatIdb$);
  context.signal.addEventListener(
    "abort",
    () => {
      db.close();
    },
    { once: true },
  );
  return db;
}

function assistantRow(
  threadId: string,
  id: string,
  content: string,
  createdAt: string,
  seqId: number,
): ChatEventRow {
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

async function setupAuthenticatedBootstrap(): Promise<void> {
  await setupBootstrap({
    context,
    path: "/error",
    user: {
      id: userId(),
      fullName: "Background Sync User",
      email: "background-sync@example.com",
    },
    session: { token: "test-token" },
    org: {
      activeOrg: { id: orgId(), name: "Background Sync Org" },
      memberships: [{ id: orgId() }],
    },
  });
}

async function setupAuthenticatedBackgroundSync(): Promise<void> {
  await setupPage({
    context,
    path: "/error",
    withoutRender: true,
    user: {
      id: userId(),
      fullName: "Background Sync User",
      email: "background-sync@example.com",
    },
    session: { token: "test-token" },
    org: {
      activeOrg: { id: orgId(), name: "Background Sync Org" },
      memberships: [{ id: orgId() }],
    },
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
  it("prefetches only the first 10 unread threads once", async () => {
    const initialThreadIdsReady = context.mocks.deferred<void>();
    const requestedThreadIds: string[] = [];
    let indicatorRequests = 0;

    context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
      indicatorRequests += 1;
      await initialThreadIdsReady.promise;
      return respond(200, {
        agents: {},
        threads: Object.fromEntries([
          ...FIRST_TEN_UNREAD_THREAD_IDS.map((threadId) => {
            return [threadId, "unread" as const];
          }),
          [ELEVENTH_UNREAD_THREAD_ID, "unread" as const],
          [OTHER_THREAD_ID, "active" as const],
          [THIRD_THREAD_ID, "active" as const],
        ]),
      });
    });
    mockMissingSnapshots();
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, params, respond }) => {
        requestedThreadIds.push(params.threadId);
        return respond(200, chatEventRowsResponse([], query));
      },
    );

    await setupAuthenticatedBackgroundSync();

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });

    expect(requestedThreadIds).toStrictEqual([]);
    initialThreadIdsReady.resolve();

    await waitFor(() => {
      expect(requestedThreadIds).toHaveLength(10);
    });
    expect(indicatorRequests).toBe(1);
    expect(new Set(requestedThreadIds)).toStrictEqual(
      new Set(FIRST_TEN_UNREAD_THREAD_IDS),
    );
  });

  it("catches up open threads plus 10 other unread threads after reconnect", async () => {
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
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, params, respond }) => {
        requestedThreadIds.push(params.threadId);
        return respond(200, chatEventRowsResponse([], query));
      },
    );

    await setupAuthenticatedBackgroundSync();

    await waitFor(() => {
      expect(requestedThreadIds).toStrictEqual([THREAD_ID]);
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    requestedThreadIds.length = 0;

    const firstOpenChatEvents = createChatEventSignals(OPEN_UNREAD_THREAD_ID);
    const secondOpenChatEvents = createChatEventSignals(OTHER_THREAD_ID);
    context.store.set(setCurrentLeftPane$, {
      kind: "thread",
      thread: createChatPanelSignals(
        firstOpenChatEvents,
        "first-open-agent",
        context.signal,
      ),
    });
    context.store.set(setCurrentRightPane$, {
      kind: "thread",
      thread: createChatPanelSignals(
        secondOpenChatEvents,
        "second-open-agent",
        context.signal,
      ),
    });
    await Promise.all([
      context.store.set(firstOpenChatEvents.setup$, context.signal),
      context.store.set(secondOpenChatEvents.setup$, context.signal),
    ]);
    unreadThreadIds = [
      ...FIRST_TEN_UNREAD_THREAD_IDS,
      ELEVENTH_UNREAD_THREAD_ID,
    ];

    context.mocks.ably.triggerReconnect();

    await waitFor(() => {
      expect(indicatorRequests).toBe(2);
      expect(requestedThreadIds).toHaveLength(12);
    });
    expect(new Set(requestedThreadIds)).toStrictEqual(
      new Set([
        ...FIRST_TEN_UNREAD_THREAD_IDS,
        ELEVENTH_UNREAD_THREAD_ID,
        OTHER_THREAD_ID,
      ]),
    );
  });

  it("fills only rows after the cached thread end", async () => {
    await setupAuthenticatedBootstrap();
    const appDb = await openTestChatDb();
    await context.store.set(
      writeIndexedDbChatEventRows$,
      {
        threadId: THREAD_ID,
        rows: [firstCachedRow, lastCachedRow],
        cursor: {
          lastEventId: lastCachedRow.id,
          lastSeqId: lastCachedRow.seqId,
          projection: "tool-redacted",
        },
        schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      },
      context.signal,
    );

    const cursors: number[] = [];
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      cursors.push(query.sinceSeqId);
      if (query.sinceSeqId === lastCachedRow.seqId) {
        return respond(200, chatEventRowsResponse([newRow], query));
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
    context.track(subscription);

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
  });

  it("skips a delayed created event whose sequence is already cached", async () => {
    await setupAuthenticatedBootstrap();
    await context.store.set(
      writeIndexedDbChatEventRows$,
      {
        threadId: THREAD_ID,
        rows: [firstCachedRow, lastCachedRow],
        cursor: {
          lastEventId: lastCachedRow.id,
          lastSeqId: lastCachedRow.seqId,
          projection: "tool-redacted",
        },
        schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      },
      context.signal,
    );

    let cachedThreadRequests = 0;
    const otherThreadRequested = context.mocks.deferred<void>();
    mockMissingSnapshots();
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, params, respond }) => {
        if (params.threadId === THREAD_ID) {
          cachedThreadRequests += 1;
        }
        if (params.threadId === OTHER_THREAD_ID) {
          otherThreadRequested.resolve();
        }
        return respond(200, chatEventRowsResponse([], query));
      },
    );

    await context.store.set(setupRealtime$, context.signal);
    const subscriberSignal = context.store.set(
      resetSubscriberSignal$,
      context.signal,
    );
    const subscription = context.store.set(
      setupChatEventBackgroundSync$,
      subscriberSignal,
    );
    context.track(subscription);

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });

    context.mocks.ably.trigger(`chatThreadMessageCreated:${THREAD_ID}`, {
      syncThroughSeqId: lastCachedRow.seqId,
    });
    context.mocks.ably.trigger(`chatThreadMessageCreated:${OTHER_THREAD_ID}`);

    await otherThreadRequested.promise;
    expect(cachedThreadRequests).toBe(0);
  });
});
