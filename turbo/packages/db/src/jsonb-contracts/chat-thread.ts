import type {
  DraftVoice,
  PersistedAttachment,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";

export type ChatThreadDraftAttachments = PersistedAttachment[];
export type ChatThreadDraftUserMessage = UserMessageInputDocument;
export type ChatThreadDraftVoice = DraftVoice;
