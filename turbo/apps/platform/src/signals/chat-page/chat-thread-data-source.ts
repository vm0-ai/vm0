import type { Command, Computed } from "ccstate";
import type {
  ModelSelectionRequest,
  GenerationTemplateRequest,
  PagedChatMessage,
  PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatThread } from "../agent-chat.ts";

export interface ChatThreadRealtimeHandlers {
  onMessageCreated$: Command<Promise<boolean>, [AbortSignal]>;
  onRunChanged$: Command<Promise<boolean>, [AbortSignal]>;
}

export interface InitialPage {
  messages: PagedChatMessage[];
  hasHistoryBefore: boolean;
  needsHistoryBackfill?: boolean;
  fetchedFromRemote?: boolean;
}

export interface PatchDraftArgs {
  threadId: string;
  content: string | null;
  attachments: PersistedAttachment[] | null;
}

export interface AppendQueuedMessageArgs {
  threadId: string;
  agentId: string;
  content: string | null;
  attachments: PersistedAttachment[] | null;
  clientMessageId: string;
  hasTextContent: boolean;
  modelSelection: ModelSelectionRequest | null;
  generationTemplate: GenerationTemplateRequest | undefined;
  forceNewSession?: boolean;
}

export interface RecallMessageArgs {
  threadId: string;
  agentId: string;
  revokesMessageId: string;
  clientMessageId: string;
}

export interface InterruptRunArgs {
  runId: string;
  clientMessageId: string;
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
  agentId: string;
  interrupts: InterruptRunArgs[];
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
  appendQueuedMessage$: Command<
    Promise<PagedChatMessage>,
    [AppendQueuedMessageArgs, AbortSignal]
  >;
  recallMessage$: Command<
    Promise<PagedChatMessage>,
    [RecallMessageArgs, AbortSignal]
  >;
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
