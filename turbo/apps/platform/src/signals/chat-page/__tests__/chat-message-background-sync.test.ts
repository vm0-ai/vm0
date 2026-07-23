import { waitFor } from "@testing-library/react";
import {
  chatThreadMessagesContract,
  type PagedChatMessage,
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
import { setupRealtime$ } from "../../realtime.ts";
import { resetSignalScope } from "../../utils.ts";
import { writeIndexedDbChatMessages$ } from "../chat-message-indexed-db.ts";
import { setupChatMessageBackgroundSync$ } from "../chat-message-background-sync.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const resetSubscriberSignal$ = resetSignalScope();

const USER_ID = "background-sync-user";
const ORG_ID = "background-sync-org";
const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const FIRST_CACHED_MESSAGE_ID = "00000000-0000-4000-8000-000000000802";
const LAST_CACHED_MESSAGE_ID = "00000000-0000-4000-8000-000000000803";
const NEW_MESSAGE_ID = "00000000-0000-4000-8000-000000000804";

function assistantMessage(
  id: string,
  content: string,
  createdAt: string,
): PagedChatMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt,
  };
}

const firstCachedMessage = assistantMessage(
  FIRST_CACHED_MESSAGE_ID,
  "First cached message",
  "2026-07-23T10:01:00.000Z",
);
const lastCachedMessage = assistantMessage(
  LAST_CACHED_MESSAGE_ID,
  "Last cached message",
  "2026-07-23T10:02:00.000Z",
);
const newMessage = assistantMessage(
  NEW_MESSAGE_ID,
  "New remote message",
  "2026-07-23T10:03:00.000Z",
);

const SKIP_THREAD_ID = "b0000000-0000-4000-a000-000000000811";
const SKIP_FIRST_ID = "00000000-0000-4000-8000-000000000812";
const SKIP_LAST_ID = "00000000-0000-4000-8000-000000000813";
const SKIP_NEW_ID = "00000000-0000-4000-8000-000000000814";
const skipFirstCached = assistantMessage(
  SKIP_FIRST_ID,
  "First cached message",
  "2026-07-23T10:01:00.000Z",
);
const skipLastCached = assistantMessage(
  SKIP_LAST_ID,
  "Last cached message",
  "2026-07-23T10:02:00.000Z",
);
const skipNewMessage = assistantMessage(
  SKIP_NEW_ID,
  "New remote message",
  "2026-07-23T10:03:00.000Z",
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

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

describe("chat message background sync", () => {
  afterEach(() => {
    clearMockedAuth();
  });

  it("fills only messages after the cached thread end", async () => {
    mockSignedInUser();
    const appDb = await context.store.get(chatIdb$);
    await context.store.set(
      writeIndexedDbChatMessages$,
      THREAD_ID,
      [firstCachedMessage, lastCachedMessage],
      context.signal,
    );

    const requests: {
      readonly sinceId: string | undefined;
      readonly beforeId: string | undefined;
    }[] = [];
    context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
      requests.push({
        sinceId: query.sinceId,
        beforeId: query.beforeId,
      });
      if (query.sinceId === LAST_CACHED_MESSAGE_ID) {
        return respond(200, {
          messages: [newMessage],
          hasHistoryBefore: true,
        });
      }
      if (query.sinceId === NEW_MESSAGE_ID) {
        return respond(200, {
          messages: [],
          hasHistoryBefore: false,
        });
      }
      throw new Error(`Unexpected message cursor: ${JSON.stringify(query)}`);
    });

    await context.store.set(setupRealtime$, context.signal);
    const subscriber = context.store.set(
      resetSubscriberSignal$,
      context.signal,
    );
    const subscription = context.store.set(
      setupChatMessageBackgroundSync$,
      subscriber.signal,
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
        { sinceId: LAST_CACHED_MESSAGE_ID, beforeId: undefined },
        { sinceId: NEW_MESSAGE_ID, beforeId: undefined },
      ]);
    } finally {
      subscriber.abort(abortError("test done"));
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
      appDb.close();
    }
  });

  it("skips the fetch when the event watermark is already cached", async () => {
    mockSignedInUser();
    const appDb = await context.store.get(chatIdb$);
    await context.store.set(
      writeIndexedDbChatMessages$,
      SKIP_THREAD_ID,
      [skipFirstCached, skipLastCached],
      context.signal,
    );

    const requests: { readonly sinceId: string | undefined }[] = [];
    context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
      requests.push({ sinceId: query.sinceId });
      if (query.sinceId === SKIP_LAST_ID) {
        return respond(200, {
          messages: [skipNewMessage],
          hasHistoryBefore: true,
        });
      }
      return respond(200, {
        messages: [],
        hasHistoryBefore: false,
      });
    });

    await context.store.set(setupRealtime$, context.signal);
    const subscriber = context.store.set(
      resetSubscriberSignal$,
      context.signal,
    );
    const subscription = context.store.set(
      setupChatMessageBackgroundSync$,
      subscriber.signal,
    );

    try {
      await waitFor(() => {
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
      });

      // Watermark already cached: the event must not trigger any fetch.
      context.mocks.ably.trigger(`chatThreadMessageCreated:${SKIP_THREAD_ID}`, {
        syncThroughMessageId: SKIP_LAST_ID,
      });
      // Watermark not cached: the forward sync runs. Events process in
      // order, so requests observed here prove the first event fetched
      // nothing.
      context.mocks.ably.trigger(`chatThreadMessageCreated:${SKIP_THREAD_ID}`, {
        syncThroughMessageId: SKIP_NEW_ID,
      });

      await waitFor(async () => {
        await expect(
          appDb.get(CHAT_MESSAGES_STORE, SKIP_NEW_ID),
        ).resolves.toMatchObject({
          id: SKIP_NEW_ID,
          threadId: SKIP_THREAD_ID,
        });
      });

      expect(requests).toStrictEqual([
        { sinceId: SKIP_LAST_ID },
        { sinceId: SKIP_NEW_ID },
      ]);
    } finally {
      subscriber.abort(abortError("test done"));
      await expect(subscription).rejects.toMatchObject({ name: "AbortError" });
      appDb.close();
    }
  });
});
