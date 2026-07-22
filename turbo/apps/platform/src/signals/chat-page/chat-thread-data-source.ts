import type { Command } from "ccstate";
import type {
  ChatRunOptionsRequest,
  CodexServiceTier,
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

export interface ChatThreadRealtimeHandlers {
  onThreadDetailChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onMessageCreated$: Command<Promise<boolean>, [AbortSignal]>;
  onMessageUpdated$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
  onRunChanged$: Command<Promise<boolean>, [AbortSignal]>;
  onAutomationsChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onArtifactsChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onWorkflowsChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onWorkflowQueueChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onSubscribed$?: Command<Promise<void> | void, [AbortSignal]>;
}

export interface PatchDraftArgs {
  threadId: string;
  content: string | null;
  attachments: PersistedAttachment[] | null;
}

export interface PatchModelSelectionArgs {
  threadId: string;
  modelSelection: {
    readonly selectedModel: string;
    readonly codexServiceTier?: CodexServiceTier;
  } | null;
}

export interface PatchComputerUseHostArgs {
  threadId: string;
  computerUseHostId: string | null;
}

export interface AppendQueuedMessageArgs {
  threadId: string;
  agentId: string;
  content: string | null;
  attachments: PersistedAttachment[] | null;
  clientMessageId: string;
  chatThreadSortEventId: string;
  hasTextContent: boolean;
  runOptions?: ChatRunOptionsRequest;
  realAgentInPreview?: boolean;
  generationTemplate: GenerationTemplateRequest | undefined;
  structuredPrompt?: UserMessageDocument;
  computerUseHostId?: string | null;
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

export interface GetMessageArgs {
  threadId: string;
  messageId: string;
}

export interface CancelRunsArgs {
  threadId: string;
  agentId: string;
  interrupts: InterruptRunArgs[];
}

export interface MarkReadArgs {
  threadId: string;
}

export interface SubscribeRealtimeArgs {
  threadId: string;
  handlers: ChatThreadRealtimeHandlers;
}
