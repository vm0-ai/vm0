import { sql } from "drizzle-orm";
import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgentDrafts } from "@vm0/db/schema/zero-agent-draft";

type MaybeStructuredMessage = UserMessageDocument | null | undefined;

interface PersistedStructuredMessage {
  readonly structuredPrompt: MaybeStructuredMessage;
  readonly structuredPromptWithFeedback: MaybeStructuredMessage;
}

/**
 * Keep the old JSONB columns readable by API versions that predate feedback
 * parts. The additive column carries the full document until those readers
 * have been retired.
 */
export function splitStructuredMessage(
  document: MaybeStructuredMessage,
): PersistedStructuredMessage {
  if (document === null || document === undefined) {
    return {
      structuredPrompt: document,
      structuredPromptWithFeedback: document,
    };
  }

  if (
    !document.parts.some((part) => {
      return part.type === "feedback";
    })
  ) {
    return {
      structuredPrompt: document,
      structuredPromptWithFeedback: null,
    };
  }

  const legacyParts = document.parts.filter((part) => {
    return part.type !== "feedback";
  });
  return {
    structuredPrompt:
      legacyParts.length > 0
        ? { ...document, parts: legacyParts }
        : document === undefined
          ? undefined
          : null,
    structuredPromptWithFeedback: document,
  };
}

export function effectiveChatMessageStructuredPrompt() {
  return sql`COALESCE(
    ${chatMessages.structuredPromptWithFeedback},
    ${chatMessages.structuredPrompt}
  )`
    .mapWith(chatMessages.structuredPrompt)
    .as("structured_prompt");
}

export function effectiveChatThreadDraftStructuredPrompt() {
  return sql`COALESCE(
    ${chatThreads.draftStructuredPromptWithFeedback},
    ${chatThreads.draftStructuredPrompt}
  )`
    .mapWith(chatThreads.draftStructuredPrompt)
    .as("draft_structured_prompt");
}

export function effectiveZeroAgentDraftStructuredPrompt() {
  return sql`COALESCE(
    ${zeroAgentDrafts.draftStructuredPromptWithFeedback},
    ${zeroAgentDrafts.draftStructuredPrompt}
  )`
    .mapWith(zeroAgentDrafts.draftStructuredPrompt)
    .as("draft_structured_prompt");
}
