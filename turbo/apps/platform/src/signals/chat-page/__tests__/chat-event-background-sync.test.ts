import { waitFor } from "@testing-library/react";
import {
  chatEventResponse,
  chatThreadEventsContract,
  type ChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearMockedAuth,
  mockOrganization,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
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

const USER_ID = "background-sync-user";
const ORG_ID = "background-sync-org";
const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000805";
const FIRST_CACHED_EVENT_ID = "00000000-0000-4000-8000-000000000802";
const LAST_CACHED_EVENT_ID = "00000000-0000-4000-8000-000000000803";
const NEW_EVENT_ID = "00000000-0000-4000-8000-000000000804";
const CREATED_AT = "2026-07-23T10:00:00.000Z";

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

describe("chat event background sync", () => {
  afterEach(() => {
    clearMockedAuth();
  });

  it("fills only messages after the cached thread end", async () => {
    mockSignedInUser();
    const appDb = await context.store.get(chatIdb$);
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
          hasHistoryBefore: true,
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

    try {
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

      expect(requests).toStrictEqual([
        { sinceSeqId: 2, beforeSeqId: undefined },
      ]);
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
        hasHistoryBefore: false,
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

    try {
      await waitFor(() => {
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
      });

      context.mocks.ably.trigger(`chatThreadMessageCreated:${THREAD_ID}`, {
        syncThroughSeqId: lastCachedEvent.seqId,
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

  it("returns canonical API response events unchanged", async () => {
    mockSignedInUser();
    const inputEventId = "00000000-0000-4000-8000-000000000806";
    const outputEventId = "00000000-0000-4000-8000-000000000807";
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Canonical input" }],
    };
    context.mocks.http.get("*/api/zero/chat-threads/:threadId/events", () => {
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
        hasHistoryBefore: false,
      });
    });

    const result = await listChatEvents(
      context.store.get(zeroClient$),
      THREAD_ID,
      {},
      context.signal,
    );

    expect(result.events).toStrictEqual([
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
