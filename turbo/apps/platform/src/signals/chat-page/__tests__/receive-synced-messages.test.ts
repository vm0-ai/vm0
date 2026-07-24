import { describe, expect, it } from "vitest";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";

import { testContext } from "../../__tests__/test-helpers.ts";
import { createDraftSignals } from "../../zero-page/chat-draft.ts";
import { createChatThreadSignals } from "../create-chat-thread.ts";
import {
  appendOptimisticChatMessage$,
  createOptimisticChatMessageEntry,
  createOptimisticChatMessagesForThread,
} from "../optimistic-chat-messages.ts";

const context = testContext();

describe("receive synced chat messages", () => {
  it("merges persistent messages and removes matching optimistic messages", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000749";
    const messageId = "00000000-0000-4000-8000-000000000749";
    const optimisticMessage = {
      id: messageId,
      role: "user" as const,
      content: "Optimistic message awaiting server persistence",
      createdAt: "2026-07-24T01:00:00.000Z",
    };
    const persistedMessage = {
      ...optimisticMessage,
      seqId: 1,
    } satisfies PagedChatMessage;

    context.store.set(
      appendOptimisticChatMessage$,
      createOptimisticChatMessageEntry({
        threadId,
        message: optimisticMessage,
      }),
    );
    expect(
      context.store.get(createOptimisticChatMessagesForThread(threadId)),
    ).toHaveLength(1);

    const thread = createChatThreadSignals(threadId, createDraftSignals());
    await context.store.set(
      thread.receiveSyncedMessages$,
      [persistedMessage],
      context.signal,
    );

    expect(
      context.store.get(createOptimisticChatMessagesForThread(threadId)),
    ).toStrictEqual([]);
    await expect(context.store.get(thread.latestChatMessageId$)).resolves.toBe(
      messageId,
    );
  });
});
