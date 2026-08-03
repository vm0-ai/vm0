import type { Command } from "ccstate";
import type {
  CodexServiceTier,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

export interface ChatThreadRealtimeHandlers {
  onThreadDetailChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onAutomationsChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onArtifactsChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onWorkflowsChanged$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  onSubscribed$?: Command<Promise<void> | void, [AbortSignal]>;
}

export interface PatchDraftArgs {
  threadId: string;
  userMessage: UserMessageDocument | null;
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
  cloudBrowserEnabled: boolean;
}

export interface SubscribeRealtimeArgs {
  threadId: string;
  handlers: ChatThreadRealtimeHandlers;
}
