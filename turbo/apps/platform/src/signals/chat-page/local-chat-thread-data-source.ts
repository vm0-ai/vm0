import { command, computed } from "ccstate";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatThread } from "../agent-chat.ts";
import type {
  AppendQueuedMessageArgs,
  CancelRunsArgs,
  ChatThreadDataSource,
  PatchModelSelectionArgs,
  RecallMessageArgs,
} from "./chat-thread-data-source.ts";

const localPatchDraft$ = command((): Promise<void> => {
  return Promise.resolve();
});

const localPatchModelSelection$ = command(
  (
    _visitor,
    _args: PatchModelSelectionArgs,
    _signal: AbortSignal,
  ): Promise<void> => {
    return Promise.resolve();
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

  const cancelRuns$ = command(
    (_visitor, _args: CancelRunsArgs, _signal: AbortSignal): Promise<void> => {
      return Promise.resolve();
    },
  );

  const localAppendQueuedMessage$ = command(
    (
      _visitor,
      args: AppendQueuedMessageArgs,
      _signal: AbortSignal,
    ): Promise<PagedChatMessage> => {
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
    patchModelSelection$: localPatchModelSelection$,
    appendQueuedMessage$: localAppendQueuedMessage$,
    recallMessage$: localRecallMessage$,
    listMessagesAfter$: localListMessagesAfter$,
    listMessagesBefore$: localListMessagesBefore$,
    cancelRuns$,
    markRead$: localMarkRead$,
    subscribeRealtime$: localSubscribeRealtime$,
  };
}
