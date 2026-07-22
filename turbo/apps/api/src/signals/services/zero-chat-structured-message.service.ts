import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

const ATTACH_ONLY_PLACEHOLDER = "(see attached files)";

export interface StructuredUserMessageProjection {
  readonly agentPrompt: string;
  readonly legacyContent: string;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly hasTextContent: boolean;
}

function serializeChatThreadMention(threadId: string, title: string): string {
  const escapedTitle = title.replace(/[\\[\]]/g, String.raw`\$&`);
  return `[${escapedTitle}](/chats/${threadId})`;
}

function webFilePrompt(part: {
  readonly fileId: string;
  readonly filenameSnapshot: string;
  readonly contentType: string;
}): string {
  return `[Web file] ${part.filenameSnapshot} (${part.contentType})\n   [ID] ${part.fileId}`;
}

function generationTemplatePrompt(part: {
  readonly titleSnapshot: string;
  readonly template: GenerationTemplateRequest;
}): string {
  return `Select ${part.titleSnapshot} ${part.template.type} template`;
}

/**
 * Projects one validated business document into the server-owned runtime
 * representations. File blocks remain in authoritative `parts` order while
 * templates are carried separately into the system prompt.
 */
export function projectStructuredUserMessage(
  document: UserMessageDocument,
): StructuredUserMessageProjection {
  const promptBlocks: string[] = [];
  let inlinePrompt = "";
  let legacyContent = "";
  let generationTemplate: GenerationTemplateRequest | undefined;
  let hasFile = false;

  const flushInlinePrompt = () => {
    if (inlinePrompt.length > 0) {
      promptBlocks.push(inlinePrompt);
      inlinePrompt = "";
    }
  };

  for (const part of document.parts) {
    if (part.type === "text") {
      inlinePrompt += part.text;
      legacyContent += part.text;
      continue;
    }
    if (part.type === "chat_thread") {
      const serialized = serializeChatThreadMention(
        part.threadId,
        part.titleSnapshot,
      );
      inlinePrompt += serialized;
      legacyContent += serialized;
      continue;
    }
    if (part.type === "file") {
      flushInlinePrompt();
      promptBlocks.push(webFilePrompt(part));
      hasFile = true;
      continue;
    }
    flushInlinePrompt();
    promptBlocks.push(generationTemplatePrompt(part));
    generationTemplate ??= part.template;
  }
  flushInlinePrompt();

  return {
    agentPrompt: promptBlocks.join("\n\n"),
    legacyContent:
      legacyContent.length > 0 || !hasFile
        ? legacyContent
        : ATTACH_ONLY_PLACEHOLDER,
    generationTemplate,
    hasTextContent: legacyContent.trim().length > 0,
  };
}
