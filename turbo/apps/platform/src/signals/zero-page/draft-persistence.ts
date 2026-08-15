import type {
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  textToMessageDocument,
  type EditorDocumentSnapshot,
} from "./user-message-document-codec.ts";

export interface DraftPersistencePayload {
  readonly userMessage: UserMessageInputDocument | null;
  readonly attachments: PersistedAttachment[] | null;
}

interface DraftPersistenceSource {
  readonly input: string;
  readonly editorDocument: EditorDocumentSnapshot | null;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly attachments: readonly PersistedAttachment[];
}

export function buildDraftPersistencePayload(
  source: DraftPersistenceSource,
): DraftPersistencePayload {
  const content = source.input.trim() || null;
  const attachments =
    source.attachments.length > 0 ? [...source.attachments] : null;
  const hasUserMessageDraft =
    content !== null ||
    source.generationTemplate !== undefined ||
    attachments !== null;

  let userMessage: UserMessageInputDocument | null = null;
  if (hasUserMessageDraft) {
    userMessage = source.editorDocument
      ? source.editorDocument.toMessageDocument({
          selectedTemplate: source.generationTemplate,
          attachments: source.attachments,
        })
      : textToMessageDocument(source.input, undefined, source.attachments);
    if (!userMessage) {
      throw new Error("Failed to serialize user-message draft");
    }
  }

  return { userMessage, attachments };
}
