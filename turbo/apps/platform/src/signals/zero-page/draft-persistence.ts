import type {
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  shouldUseStructuredPrompt,
  type EditorDocumentSnapshot,
} from "./user-message-document-codec.ts";

export interface DraftPersistencePayload {
  readonly content: string | null;
  readonly structuredPrompt: UserMessageDocument | null;
  readonly attachments: PersistedAttachment[] | null;
}

interface DraftPersistenceSource {
  readonly input: string;
  readonly structuredPromptEnabled: boolean;
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
  const hasStructuredDraft =
    content !== null ||
    source.generationTemplate !== undefined ||
    attachments !== null;

  let structuredPrompt: UserMessageDocument | null = null;
  if (source.editorDocument && hasStructuredDraft) {
    const document = source.editorDocument.toMessageDocument({
      generationTemplate: source.generationTemplate,
      attachments: source.attachments,
    });
    if (source.structuredPromptEnabled && !document) {
      throw new Error("Failed to serialize structured draft");
    }
    if (shouldUseStructuredPrompt(source.structuredPromptEnabled, document)) {
      structuredPrompt = document;
    }
  }

  return { content, structuredPrompt, attachments };
}
