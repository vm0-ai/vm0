import type {
  DraftVoice,
  PersistedAttachment,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";

export type AgentDraftAttachments = PersistedAttachment[];
export type AgentDraftUserMessage = UserMessageInputDocument;
export type AgentDraftVoice = DraftVoice;
