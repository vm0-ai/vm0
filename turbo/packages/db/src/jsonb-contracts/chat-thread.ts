import type {
  PersistedAttachment,
  ThreadGenerationTemplates,
  UserMessageInputDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

export type ChatThreadDraftAttachments = PersistedAttachment[];
export type ChatThreadDraftUserMessage = UserMessageInputDocument;
export type ChatThreadGenerationTemplate = ThreadGenerationTemplates;
