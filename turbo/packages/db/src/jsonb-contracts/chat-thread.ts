import type {
  ChatMessageFeedbackPayload,
  PersistedAttachment,
  ThreadGenerationTemplates,
} from "@vm0/api-contracts/contracts/chat-threads";

export type ChatThreadDraftAttachments = PersistedAttachment[];
export type ChatThreadDraftFeedbackPayload = ChatMessageFeedbackPayload;
export type ChatThreadGenerationTemplate = ThreadGenerationTemplates;
