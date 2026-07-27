import type { Command } from "ccstate";
import type {
  ChatRunOptionsRequest,
  CodexServiceTier,
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

export interface ChatThreadRealtimeHandlers {
  onAutomationsChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onArtifactsChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onWorkflowsChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onWorkflowQueueChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onSubscribed$?: Command<Promise<void> | void, [AbortSignal]>;
}

export interface PatchDraftArgs {
  threadId: string;
  content: string | null;
  structuredPrompt: UserMessageDocument | null;
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

export interface AppendQueuedEventArgs {
  threadId: string;
  agentId: string;
  content: string | null;
  attachments: PersistedAttachment[] | null;
  clientEventId: string;
  chatThreadSortEventId: string;
  hasTextContent: boolean;
  runOptions?: ChatRunOptionsRequest;
  realAgentInPreview?: boolean;
  generationTemplate: GenerationTemplateRequest | undefined;
  structuredPrompt?: UserMessageDocument;
  computerUseHostId?: string | null;
}

export interface RecallEventArgs {
  threadId: string;
  agentId: string;
  revokesEventId: string;
  clientEventId: string;
}

export interface InterruptRunArgs {
  runId: string;
  clientEventId: string;
}

export interface ListEventsAfterArgs {
  threadId: string;
  sinceSeqId: number | undefined;
}

export interface ListEventsBeforeArgs {
  threadId: string;
  beforeSeqId: number;
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
