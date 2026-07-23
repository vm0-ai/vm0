import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  featureSwitch$,
  reloadFeatureSwitch$,
} from "../external/feature-switch.ts";
import { setAblyMessageLoop$ } from "../realtime.ts";
import {
  loadIndexedDbChatMessageBounds$,
  writeIndexedDbChatMessages$,
} from "./chat-message-indexed-db.ts";
import {
  listMessagesAfter$,
  listMessagesBefore$,
} from "./remote-chat-thread-data-source.ts";
import { logger } from "../log.ts";

const L = logger("ChatMessageBackgroundSync");
const CHAT_THREAD_MESSAGE_CREATED_PREFIX = "chatThreadMessageCreated:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createdMessageThreadId(message: unknown): string | null {
  if (
    typeof message !== "object" ||
    message === null ||
    !("name" in message) ||
    typeof message.name !== "string" ||
    !message.name.startsWith(CHAT_THREAD_MESSAGE_CREATED_PREFIX)
  ) {
    return null;
  }
  const threadId = message.name.slice(
    CHAT_THREAD_MESSAGE_CREATED_PREFIX.length,
  );
  return UUID_PATTERN.test(threadId) ? threadId : null;
}

export const syncChatThreadMessagesToIndexedDb$ = command(
  async ({ set }, threadId: string, signal: AbortSignal): Promise<void> => {
    const bounds = await set(loadIndexedDbChatMessageBounds$, threadId, signal);
    signal.throwIfAborted();

    let sinceId = bounds.last?.id;
    const startedWithoutCursor = sinceId === undefined;
    let initialHasHistoryBefore: boolean | undefined;
    let firstFetchedMessageId: string | undefined;

    async function syncMessagesAfter(): Promise<void> {
      const requestedSinceId = sinceId;
      const result = await set(
        listMessagesAfter$,
        { threadId, sinceId: requestedSinceId },
        signal,
      );
      signal.throwIfAborted();

      if (requestedSinceId === undefined) {
        initialHasHistoryBefore = result.hasHistoryBefore;
      }
      firstFetchedMessageId ??= result.messages[0]?.id;

      if (result.messages.length === 0) {
        return;
      }

      await set(writeIndexedDbChatMessages$, threadId, result.messages, signal);
      signal.throwIfAborted();
      sinceId = result.messages.at(-1)!.id;
      await syncMessagesAfter();
    }

    await syncMessagesAfter();
    signal.throwIfAborted();

    const oldestMessageId = bounds.first?.id ?? firstFetchedMessageId;
    if (
      oldestMessageId === undefined ||
      (startedWithoutCursor && initialHasHistoryBefore === false)
    ) {
      return;
    }

    let beforeId = oldestMessageId;
    async function syncMessagesBefore(): Promise<void> {
      const result = await set(
        listMessagesBefore$,
        { threadId, beforeId },
        signal,
      );
      signal.throwIfAborted();

      if (result.messages.length > 0) {
        await set(
          writeIndexedDbChatMessages$,
          threadId,
          result.messages,
          signal,
        );
        signal.throwIfAborted();
      }

      if (!result.hasHistoryBefore) {
        return;
      }

      beforeId = result.messages[0]!.id;
      await syncMessagesBefore();
    }

    await syncMessagesBefore();
    signal.throwIfAborted();
    L.debug("synced chat messages to IndexedDB", { threadId });
  },
);

const handleUserChannelMessage$ = command(
  async ({ set }, message: unknown, signal: AbortSignal): Promise<boolean> => {
    const threadId = createdMessageThreadId(message);
    if (!threadId) {
      return false;
    }

    await set(syncChatThreadMessagesToIndexedDb$, threadId, signal);
    signal.throwIfAborted();
    return false;
  },
);

export const subscribeChatMessageBackgroundSync$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(
      setAblyMessageLoop$,
      { loopCommand$: handleUserChannelMessage$ },
      signal,
    );
  },
);

export const setupChatMessageBackgroundSync$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await set(reloadFeatureSwitch$, signal);
    signal.throwIfAborted();
    if (
      !get(featureSwitch$)[FeatureSwitchKey.ChatThreadMessageBackgroundSync]
    ) {
      return;
    }

    await set(subscribeChatMessageBackgroundSync$, signal);
  },
);
