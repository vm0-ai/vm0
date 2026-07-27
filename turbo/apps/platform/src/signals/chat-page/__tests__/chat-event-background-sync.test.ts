import { waitFor } from "@testing-library/react";
import {
  chatEventResponse,
  chatEventsContract,
  chatMessagesContract,
  chatThreadEventsContract,
  precedingChatThreadMessagesContract,
  type ChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearMockedAuth,
  mockOrganization,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { CHAT_MESSAGES_STORE } from "../../external/chat-idb-schema.ts";
import { chatIdb$ } from "../../external/chat-idb-store.ts";
import { zeroClient$ } from "../../api-client.ts";
import { setupRealtime$ } from "../../realtime.ts";
import { resetSignal } from "../../utils.ts";
import { writeIndexedDbChatEvents$ } from "../chat-event-indexed-db.ts";
import { setupChatEventBackgroundSync$ } from "../chat-event-background-sync.ts";
import { sendChatEventWithCompatibility } from "../chat-event-api-rollout.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const resetSubscriberSignal$ = resetSignal();

const USER_ID = "background-sync-user";
const ORG_ID = "background-sync-org";
const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000805";
const FIRST_CACHED_MESSAGE_ID = "00000000-0000-4000-8000-000000000802";
const LAST_CACHED_MESSAGE_ID = "00000000-0000-4000-8000-000000000803";
const NEW_MESSAGE_ID = "00000000-0000-4000-8000-000000000804";
const LEGACY_MESSAGE_ID = "00000000-0000-4000-8000-000000000806";

function assistantMessage(
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

const firstCachedMessage = assistantMessage(
  THREAD_ID,
  FIRST_CACHED_MESSAGE_ID,
  "First cached message",
  "2026-07-23T10:01:00.000Z",
  1,
);
const lastCachedMessage = assistantMessage(
  THREAD_ID,
  LAST_CACHED_MESSAGE_ID,
  "Last cached message",
  "2026-07-23T10:02:00.000Z",
  2,
);
const newMessage = assistantMessage(
  THREAD_ID,
  NEW_MESSAGE_ID,
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
      [firstCachedMessage, lastCachedMessage],
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
      if (query.sinceSeqId === lastCachedMessage.seqId) {
        return respond(200, {
          events: [chatEventResponse(newMessage)],
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
          appDb.get(CHAT_MESSAGES_STORE, NEW_MESSAGE_ID),
        ).resolves.toMatchObject({
          id: NEW_MESSAGE_ID,
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
      [firstCachedMessage, lastCachedMessage],
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
        syncThroughSeqId: lastCachedMessage.seqId,
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

  it("falls back to the preceding message route and stores canonical events", async () => {
    mockSignedInUser();
    const appDb = await context.store.get(chatIdb$);
    let eventRequests = 0;
    let messageRequests = 0;
    context.mocks.api(chatThreadEventsContract.list, ({ respond }) => {
      eventRequests += 1;
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Event route not deployed" },
      });
    });
    context.mocks.api(
      precedingChatThreadMessagesContract.list,
      ({ query, respond }) => {
        messageRequests += 1;
        if (query.sinceSeqId) {
          return respond(200, {
            messages: [],
            hasHistoryBefore: false,
          });
        }
        return respond(200, {
          messages: [
            {
              id: LEGACY_MESSAGE_ID,
              role: "assistant",
              content: "Legacy remote message",
              seqId: 1,
              createdAt: "2026-07-23T10:04:00.000Z",
            },
          ],
          hasHistoryBefore: false,
        });
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

    try {
      await waitFor(() => {
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
      });

      context.mocks.ably.trigger(`chatThreadMessageCreated:${OTHER_THREAD_ID}`);

      await waitFor(async () => {
        await expect(
          appDb.get(CHAT_MESSAGES_STORE, LEGACY_MESSAGE_ID),
        ).resolves.toMatchObject({
          id: LEGACY_MESSAGE_ID,
          threadId: OTHER_THREAD_ID,
          eventType: "output.message",
        });
      });
      expect(eventRequests).toBe(2);
      expect(messageRequests).toBe(2);
    } finally {
      context.store.set(resetSubscriberSignal$, context.signal);
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
      appDb.close();
    }
  });

  it("falls back to the preceding write route with message-named ids", async () => {
    mockSignedInUser();
    const clientEventId = "00000000-0000-4000-8000-000000000807";
    let legacyBody: unknown;
    context.mocks.api(chatEventsContract.send, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Event route not deployed" },
      });
    });
    context.mocks.api(chatMessagesContract.send, ({ body, respond }) => {
      legacyBody = body;
      return respond(201, {
        runId: null,
        threadId: THREAD_ID,
      });
    });

    await expect(
      sendChatEventWithCompatibility(
        context.store.get(zeroClient$),
        {
          agentId: "agent-1",
          threadId: THREAD_ID,
          revokesEventId: FIRST_CACHED_MESSAGE_ID,
          clientEventId,
        },
        context.signal,
      ),
    ).resolves.toMatchObject({ threadId: THREAD_ID });
    expect(legacyBody).toMatchObject({
      agentId: "agent-1",
      threadId: THREAD_ID,
      revokesMessageId: FIRST_CACHED_MESSAGE_ID,
      clientMessageId: clientEventId,
    });
    expect(legacyBody).not.toHaveProperty("revokesEventId");
    expect(legacyBody).not.toHaveProperty("clientEventId");
  });
});
