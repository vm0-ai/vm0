import type { Command, Computed } from "ccstate";
import type {
  PagedChatMessage,
  PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatThread } from "../agent-chat.ts";

export interface ChatThreadRealtimeHandlers {
  onMessageCreated$: Command<Promise<boolean>, [AbortSignal]>;
  onRunChanged$: Command<boolean, []>;
}

export interface InitialPage {
  messages: PagedChatMessage[];
  hasHistoryBefore: boolean;
}

export interface PatchDraftArgs {
  threadId: string;
  content: string | null;
  attachments: PersistedAttachment[] | null;
}

export interface ListMessagesAfterArgs {
  threadId: string;
  sinceId: string | undefined;
}

export interface ListMessagesBeforeArgs {
  threadId: string;
  beforeId: string;
}

export interface CancelRunsArgs {
  threadId: string;
  activeRunIds: string[];
}

export interface MarkReadArgs {
  threadId: string;
  latestMessageId: string;
}

export interface SubscribeRealtimeArgs {
  threadId: string;
  handlers: ChatThreadRealtimeHandlers;
}

export interface ChatThreadDataSource {
  getThread$: Computed<Promise<ChatThread | null>>;
  reloadThread$: Command<void, []>;
  initialPage$: Computed<Promise<InitialPage>>;
  patchDraft$: Command<Promise<void>, [PatchDraftArgs, AbortSignal]>;
  listMessagesAfter$: Command<
    Promise<{ messages: PagedChatMessage[]; reachedEnd: boolean }>,
    [ListMessagesAfterArgs, AbortSignal]
  >;
  listMessagesBefore$: Command<
    Promise<{ messages: PagedChatMessage[]; hasMore: boolean }>,
    [ListMessagesBeforeArgs, AbortSignal]
  >;
  cancelRuns$: Command<Promise<void>, [CancelRunsArgs, AbortSignal]>;
  markRead$: Command<Promise<string | null>, [MarkReadArgs, AbortSignal]>;
  subscribeRealtime$: Command<
    Promise<void>,
    [SubscribeRealtimeArgs, AbortSignal]
  >;
}
