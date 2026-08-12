import { waitFor } from "@testing-library/react";
import {
  chatEventResponse,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it, vi } from "vitest";

import {
  clearMockedAuthOnAbort,
  mockOrganization,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { zeroClient$ } from "../../api-client.ts";
import { CHAT_MESSAGES_STORE } from "../../external/chat-idb-schema.ts";
import { chatIdb$ } from "../../external/chat-idb-store.ts";
import { setupRealtime$ } from "../../realtime.ts";
import { resetSignal } from "../../utils.ts";
import { writeIndexedDbChatEvents$ } from "../chat-event-indexed-db.ts";
import { setupChatEventBackgroundSync$ } from "../chat-event-background-sync.ts";
import { listChatEvents } from "../chat-event-api.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const resetSubscriberSignal$ = resetSignal();

const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000805";
const THIRD_THREAD_ID = "b0000000-0000-4000-a000-000000000809";
const FIRST_CACHED_EVENT_ID = "00000000-0000-4000-8000-000000000802";
const LAST_CACHED_EVENT_ID = "00000000-0000-4000-8000-000000000803";
const NEW_EVENT_ID = "00000000-0000-4000-8000-000000000804";
const CREATED_AT = "2026-07-23T10:00:00.000Z";

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

function assistantEvent(
  threadId: string,
  id: string,
  content: string,
  createdAt: string,
  seqId: number,
): ChatEvent {
  return {
    id,
    threadId,
    eventType: "output.message" as const,
    content,
    createdAt,
    seqId,
  };
}

const firstCachedEvent = assistantEvent(
  THREAD_ID,
  FIRST_CACHED_EVENT_ID,
  "First cached message",
  "2026-07-23T10:01:00.000Z",
  1,
);
const lastCachedEvent = assistantEvent(
  THREAD_ID,
  LAST_CACHED_EVENT_ID,
  "Last cached message",
  "2026-07-23T10:02:00.000Z",
  2,
);
const newEvent = assistantEvent(
  THREAD_ID,
  NEW_EVENT_ID,
  "New remote message",
  "2026-07-23T10:03:00.000Z",
  3,
);

function mockSignedInUser(): void {
  clearMockedAuthOnAbort(context.signal);
  mockUser(
    {
      id: userId(),
      fullName: "Background Sync User",
      email: "background-sync@example.com",
    },
    { token: "test-token" },
  );
  mockOrganization({
    activeOrg: { id: orgId(), name: "Background Sync Org" },
    memberships: [{ id: orgId() }],
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

describe("chat event background sync", () => {
  it("subscribes while prefetching unread and active threads once", async () => {
    const initialThreadIdsReady = context.mocks.deferred<void>();
    const requestedThreadIds: string[] = [];

    context.mocks.api(chatThreadsContract.unreadIds, async ({ respond }) => {
      await initialThreadIdsReady.promise;
      return respond(200, { threadIds: [THREAD_ID, OTHER_THREAD_ID] });
    });
    context.mocks.api(chatThreadsContract.activeIds, async ({ respond }) => {
      await initialThreadIdsReady.promise;
      return respond(200, { threadIds: [OTHER_THREAD_ID, THIRD_THREAD_ID] });
    });
    context.mocks.api(chatThreadEventsContract.list, ({ params, respond }) => {
      requestedThreadIds.push(params.threadId);
      return respond(200, { events: [] });
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
    expect(new Set(requestedThreadIds)).toStrictEqual(
      new Set([THREAD_ID, OTHER_THREAD_ID, THIRD_THREAD_ID]),
    );
  });

  it("catches up only unread threads after reconnect", async () => {
    const requestedThreadIds: string[] = [];
    let unreadThreadIds = [THREAD_ID];
    let unreadIdsRequests = 0;

    context.mocks.api(chatThreadsContract.unreadIds, ({ respond }) => {
      unreadIdsRequests += 1;
      return respond(200, { threadIds: unreadThreadIds });
    });
    context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
      return respond(200, { threadIds: [OTHER_THREAD_ID] });
    });
    context.mocks.api(chatThreadEventsContract.list, ({ params, respond }) => {
      requestedThreadIds.push(params.threadId);
      return respond(200, { events: [] });
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
      expect(unreadIdsRequests).toBe(2);
      expect(requestedThreadIds).toStrictEqual([THIRD_THREAD_ID]);
    });
  });

  it("fills only messages after the cached thread end", async () => {
    mockSignedInUser();
    const appDb = await openTestChatDb();
    await context.store.set(
      writeIndexedDbChatEvents$,
      THREAD_ID,
      [firstCachedEvent, lastCachedEvent],
      context.signal,
    );

    const requests: {
      readonly sinceSeqId: number | undefined;
      readonly beforeSeqId: number | undefined;
    }[] = [];
    context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
      requests.push({
        sinceSeqId: query.sinceSeqId,
        beforeSeqId: query.beforeSeqId,
      });
      if (query.sinceSeqId === lastCachedEvent.seqId) {
        return respond(200, {
          events: [chatEventResponse(newEvent)],
        });
      }
      throw new Error(`Unexpected message cursor: ${JSON.stringify(query)}`);
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
        appDb.get(CHAT_MESSAGES_STORE, NEW_EVENT_ID),
      ).resolves.toMatchObject({
        id: NEW_EVENT_ID,
        threadId: THREAD_ID,
      });
    });

    expect(requests).toStrictEqual([{ sinceSeqId: 2, beforeSeqId: undefined }]);
  });

  it("skips a delayed created event whose sequence is already cached", async () => {
    mockSignedInUser();
    await context.store.set(
      writeIndexedDbChatEvents$,
      THREAD_ID,
      [firstCachedEvent, lastCachedEvent],
      context.signal,
    );

    let cachedThreadRequests = 0;
    const otherThreadRequested = context.mocks.deferred<void>();
    context.mocks.api(chatThreadEventsContract.list, ({ params, respond }) => {
      if (params.threadId === THREAD_ID) {
        cachedThreadRequests += 1;
      }
      if (params.threadId === OTHER_THREAD_ID) {
        otherThreadRequested.resolve();
      }
      return respond(200, {
        events: [],
      });
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

    context.mocks.ably.trigger(`chatThreadMessageCreated:${THREAD_ID}`, {
      syncThroughSeqId: lastCachedEvent.seqId,
    });
    context.mocks.ably.trigger(`chatThreadMessageCreated:${OTHER_THREAD_ID}`);

    await otherThreadRequested.promise;
    expect(cachedThreadRequests).toBe(0);
  });

  it("returns canonical API response events unchanged", async () => {
    mockSignedInUser();
    const inputEventId = "00000000-0000-4000-8000-000000000806";
    const outputEventId = "00000000-0000-4000-8000-000000000807";
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Canonical input" }],
    };
    context.mocks.http.get("*/api/okou/chat-threads/:threadId/events", () => {
      return Response.json({
        events: [
          {
            id: inputEventId,
            threadId: THREAD_ID,
            eventType: "input.prompt",
            content: null,
            userMessage,
            seqId: 1,
            createdAt: CREATED_AT,
          },
          {
            id: outputEventId,
            threadId: THREAD_ID,
            eventType: "output.message",
            content: "Canonical output",
            seqId: 2,
            createdAt: CREATED_AT,
          },
        ],
      });
    });

    const events = await listChatEvents(
      context.store.get(zeroClient$),
      THREAD_ID,
      {},
      context.signal,
    );

    expect(events).toStrictEqual([
      {
        id: inputEventId,
        threadId: THREAD_ID,
        eventType: "input.prompt",
        content: null,
        userMessage,
        seqId: 1,
        createdAt: CREATED_AT,
      },
      {
        id: outputEventId,
        threadId: THREAD_ID,
        eventType: "output.message",
        content: "Canonical output",
        seqId: 2,
        createdAt: CREATED_AT,
      },
    ]);
  });
});
