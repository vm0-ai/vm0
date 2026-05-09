import { command, computed } from "ccstate";
import type {
  PagedChatMessage,
  PendingMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatThread } from "../agent-chat.ts";
import type {
  ChatThreadDataSource,
  RecallPendingMessageResult,
  ReplacePendingMessageArgs,
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
  takePendingMessageReplacement: () => ReplacePendingMessageArgs | null;
}

export function createLocalChatThreadDataSource(input: {
  threadData: ChatThread;
  messages: PagedChatMessage[];
}): LocalChatThreadDataSource {
  const { threadData, messages } = input;
  let pendingMessageReplacement: ReplacePendingMessageArgs | null = null;

  const getThread$ = computed((): Promise<ChatThread | null> => {
    return Promise.resolve(threadData);
  });

  const initialPage$ = computed(() => {
    return Promise.resolve({ messages, hasHistoryBefore: false });
  });

  const cancelRuns$ = command((): Promise<void> => {
    return Promise.resolve();
  });

  const localReplacePendingMessage$ = command(
    (
      _visitor,
      args: ReplacePendingMessageArgs,
      _signal: AbortSignal,
    ): Promise<PendingMessage> => {
      pendingMessageReplacement = {
        ...args,
        attachments: args.attachments ? [...args.attachments] : null,
      };
      const now = new Date().toISOString();
      return Promise.resolve({
        content: args.content,
        attachments: args.attachments ? [...args.attachments] : null,
        createdAt: now,
        updatedAt: now,
        clientMessageId: args.clientMessageId,
      });
    },
  );

  const localRecallPendingMessage$ = command(
    (): Promise<RecallPendingMessageResult> => {
      pendingMessageReplacement = null;
      return Promise.resolve({ draftContent: null, draftAttachments: null });
    },
  );

  return {
    getThread$,
    reloadThread$: localReloadThread$,
    initialPage$,
    patchDraft$: localPatchDraft$,
    replacePendingMessage$: localReplacePendingMessage$,
    recallPendingMessage$: localRecallPendingMessage$,
    listMessagesAfter$: localListMessagesAfter$,
    listMessagesBefore$: localListMessagesBefore$,
    cancelRuns$,
    markRead$: localMarkRead$,
    subscribeRealtime$: localSubscribeRealtime$,
    takePendingMessageReplacement: () => {
      const replacement = pendingMessageReplacement;
      pendingMessageReplacement = null;
      return replacement;
    },
  };
}
