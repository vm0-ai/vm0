import { command, computed } from "ccstate";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatThread } from "../agent-chat.ts";
import type {
  AppendQueuedMessageArgs,
  ChatThreadDataSource,
  RecallMessageArgs,
} from "./chat-thread-data-source.ts";

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

export interface LocalChatThreadDataSource extends ChatThreadDataSource {
  takeQueuedMessageAppends: () => AppendQueuedMessageArgs[];
}

export function createLocalChatThreadDataSource(input: {
  threadData: ChatThread;
  messages: PagedChatMessage[];
}): LocalChatThreadDataSource {
  const { threadData, messages } = input;
  let queuedMessageAppends: AppendQueuedMessageArgs[] = [];

  const getThread$ = computed((): Promise<ChatThread | null> => {
    return Promise.resolve(threadData);
  });

  const initialPage$ = computed(() => {
    return Promise.resolve({ messages, hasHistoryBefore: false });
  });

  const cancelRuns$ = command((): Promise<void> => {
    return Promise.resolve();
  });

  const localAppendQueuedMessage$ = command(
    (
      _visitor,
      args: AppendQueuedMessageArgs,
      _signal: AbortSignal,
    ): Promise<PagedChatMessage> => {
      queuedMessageAppends = [
        ...queuedMessageAppends,
        {
          ...args,
          attachments: args.attachments ? [...args.attachments] : null,
        },
      ];
      return Promise.resolve({
        id: args.clientMessageId,
        role: "user",
        content: args.content,
        attachFiles: args.attachments ? [...args.attachments] : undefined,
        createdAt: new Date().toISOString(),
      });
    },
  );

  const localRecallMessage$ = command(
    (
      _visitor,
      args: RecallMessageArgs,
      _signal: AbortSignal,
    ): Promise<PagedChatMessage> => {
      queuedMessageAppends = queuedMessageAppends.filter((append) => {
        return append.clientMessageId !== args.revokesMessageId;
      });
      return Promise.resolve({
        id: args.clientMessageId,
        role: "user",
        content: null,
        revokesMessageId: args.revokesMessageId,
        createdAt: new Date().toISOString(),
      });
    },
  );

  return {
    getThread$,
    reloadThread$: localReloadThread$,
    initialPage$,
    patchDraft$: localPatchDraft$,
    appendQueuedMessage$: localAppendQueuedMessage$,
    recallMessage$: localRecallMessage$,
    listMessagesAfter$: localListMessagesAfter$,
    listMessagesBefore$: localListMessagesBefore$,
    cancelRuns$,
    markRead$: localMarkRead$,
    subscribeRealtime$: localSubscribeRealtime$,
    takeQueuedMessageAppends: () => {
      const appends = queuedMessageAppends.map((append) => {
        return {
          ...append,
          attachments: append.attachments ? [...append.attachments] : null,
        };
      });
      queuedMessageAppends = [];
      return appends;
    },
  };
}
