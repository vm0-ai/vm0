import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

const ATTACH_ONLY_PLACEHOLDER = "(see attached files)";

interface StructuredUserMessageProjection {
  readonly agentPrompt: string;
  readonly displayText: string;
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
  const displayBlocks: string[] = [];
  let inlinePrompt = "";
  let inlineDisplayText = "";
  let legacyContent = "";
  let generationTemplate: GenerationTemplateRequest | undefined;
  let hasFile = false;

  const flushInlinePrompt = () => {
    if (inlinePrompt.length > 0) {
      promptBlocks.push(inlinePrompt);
      inlinePrompt = "";
    }
    if (inlineDisplayText.length > 0) {
      displayBlocks.push(inlineDisplayText);
      inlineDisplayText = "";
    }
  };

  for (const part of document.parts) {
    if (part.type === "text") {
      inlinePrompt += part.text;
      inlineDisplayText += part.text;
      legacyContent += part.text;
      continue;
    }
    if (part.type === "chat_thread") {
      const serialized = serializeChatThreadMention(
        part.threadId,
        part.titleSnapshot,
      );
      inlinePrompt += serialized;
      inlineDisplayText += `[Chat thread: ${part.titleSnapshot}]`;
      legacyContent += serialized;
      continue;
    }
    if (part.type === "file") {
      flushInlinePrompt();
      promptBlocks.push(webFilePrompt(part));
      displayBlocks.push(`[File: ${part.filenameSnapshot}]`);
      hasFile = true;
      continue;
    }
    flushInlinePrompt();
    promptBlocks.push(generationTemplatePrompt(part));
    displayBlocks.push(`[Template: ${part.titleSnapshot}]`);
    generationTemplate ??= part.template;
  }
  flushInlinePrompt();

  return {
    agentPrompt: promptBlocks.join("\n\n"),
    displayText: displayBlocks.join("\n\n"),
    legacyContent:
      legacyContent.length > 0 || !hasFile
        ? legacyContent
        : ATTACH_ONLY_PLACEHOLDER,
    generationTemplate,
    hasTextContent: legacyContent.trim().length > 0,
  };
}
