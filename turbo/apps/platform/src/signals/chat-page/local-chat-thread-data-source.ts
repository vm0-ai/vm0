import { command, computed } from "ccstate";
import type {
  PagedChatMessage,
  PendingMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatThread } from "../agent-chat.ts";
import type {
  AppendPendingMessageArgs,
  ChatThreadDataSource,
  RecallPendingMessageResult,
} from "./chat-thread-data-source.ts";

const localPatchDraft$ = command((): Promise<void> => {
  return Promise.resolve();
});

const localAppendPendingMessage$ = command(
  (
    _visitor,
    args: AppendPendingMessageArgs,
    _signal: AbortSignal,
  ): Promise<PendingMessage> => {
    const now = new Date().toISOString();
    return Promise.resolve({
      content: args.content ?? null,
      attachments: args.attachments ?? null,
      createdAt: now,
      updatedAt: now,
    });
  },
);

const localRecallPendingMessage$ = command(
  (): Promise<RecallPendingMessageResult> => {
    return Promise.resolve({ draftContent: null, draftAttachments: null });
  },
);

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
    appendPendingMessage$: localAppendPendingMessage$,
    recallPendingMessage$: localRecallPendingMessage$,
    listMessagesAfter$: localListMessagesAfter$,
    listMessagesBefore$: localListMessagesBefore$,
    cancelRuns$,
    markRead$: localMarkRead$,
    subscribeRealtime$: localSubscribeRealtime$,
  };
}
