import { command, computed } from "ccstate";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatThread } from "../agent-chat.ts";
import type { ChatThreadDataSource } from "./chat-thread-data-source.ts";

const localPatchDraft$ = command((): Promise<void> => {
  return Promise.resolve();
});

const localListMessagesAfter$ = command(() => {
  return Promise.resolve({
    messages: [] as PagedChatMessage[],
    reachedEnd: true,
  });
});

const localListMessagesBefore$ = command(() => {
  return Promise.resolve({
    messages: [] as PagedChatMessage[],
    hasMore: false,
  });
});

const localMarkRead$ = command((): Promise<string | null> => {
  return Promise.resolve(null);
});

const localSubscribeRealtime$ = command((): Promise<void> => {
  return Promise.resolve();
});

const localReloadThread$ = command(() => {
  // Local snapshot is fixed for the optimistic lifetime — nothing to reload.
});

export function createLocalChatThreadDataSource(input: {
  threadData: ChatThread;
  messages: PagedChatMessage[];
}): ChatThreadDataSource {
  const { threadData, messages } = input;

  const getThread$ = computed((): Promise<ChatThread | null> => {
    return Promise.resolve(threadData);
  });

  const initialPage$ = computed(() => {
    return Promise.resolve({ messages, hasHistoryBefore: false });
  });

  const cancelRuns$ = command((): Promise<void> => {
    return Promise.resolve();
  });

  return {
    getThread$,
    reloadThread$: localReloadThread$,
    initialPage$,
    patchDraft$: localPatchDraft$,
    listMessagesAfter$: localListMessagesAfter$,
    listMessagesBefore$: localListMessagesBefore$,
    cancelRuns$,
    markRead$: localMarkRead$,
    subscribeRealtime$: localSubscribeRealtime$,
  };
}
