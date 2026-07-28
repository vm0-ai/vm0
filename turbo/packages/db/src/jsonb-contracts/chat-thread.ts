import type {
  PersistedAttachment,
  ThreadGenerationTemplates,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

export type ChatThreadDraftAttachments = PersistedAttachment[];
export type ChatThreadDraftUserMessage = UserMessageDocument;
export type ChatThreadGenerationTemplate = ThreadGenerationTemplates;
