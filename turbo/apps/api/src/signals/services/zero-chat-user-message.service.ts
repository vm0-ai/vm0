import type {
  FeedbackNotePart,
  GenerationTemplateRequest,
  UserMessageDocument,
  UserMessagePart,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  isChatUserMessageEventType,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";

interface UserMessageProjection {
  readonly agentPrompt: string;
  readonly displayText: string;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly generationTemplates: readonly GenerationTemplateRequest[];
  readonly hasTextContent: boolean;
}

interface UserMessageFile {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
}

export function requiredUserMessageForEvent(
  eventType: ChatEventType,
  document: UserMessageDocument | null,
): UserMessageDocument | null {
  if (!isChatUserMessageEventType(eventType)) {
    return null;
  }
  if (document === null) {
    throw new Error(`${eventType} chat event is missing userMessage`);
  }
  return document;
}

export function maybeCreateUserMessageDocument(args: {
  readonly text: string | null;
  readonly files?: readonly UserMessageFile[];
}): UserMessageDocument | null {
  const parts: UserMessagePart[] = (args.files ?? []).map((file) => {
    return {
      type: "file",
      fileId: file.id,
      filenameSnapshot: file.filename,
      contentType: file.contentType,
    };
  });
  if (args.text !== null && args.text.length > 0) {
    parts.push({ type: "text", text: args.text });
  }
  return parts.length > 0 ? { version: 1, parts } : null;
}

export function createUserMessageDocument(args: {
  readonly text: string | null;
  readonly files?: readonly UserMessageFile[];
}): UserMessageDocument {
  const document = maybeCreateUserMessageDocument(args);
  if (!document) {
    throw new Error("User message must contain text or files");
  }
  return document;
}

function serializeChatThreadMention(threadId: string, title: string): string {
  const escapedTitle = title.replace(/[\\[\]]/g, String.raw`\$&`);
  return `[${escapedTitle}](/chats/${threadId})`;
}

function serializeFeedbackNote(
  parts: readonly FeedbackNotePart[],
  serializeTemplate: (
    part: Extract<FeedbackNotePart, { type: "template" }>,
  ) => string = generationTemplatePrompt,
): string {
  return parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "chat_thread") {
        return serializeChatThreadMention(part.threadId, part.titleSnapshot);
      }
      return serializeTemplate(part);
    })
    .join("");
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

function inlineGenerationTemplatePrompt(
  part: {
    readonly titleSnapshot: string;
    readonly template: GenerationTemplateRequest;
  },
  referenceNumber: number,
): string {
  return `[Template #${referenceNumber}: ${part.titleSnapshot} (${part.template.type})]`;
}

function formatFeedbackParts(
  parts: readonly Extract<UserMessagePart, { type: "feedback" }>[],
  serializeTemplate?: (
    part: Extract<FeedbackNotePart, { type: "template" }>,
  ) => string,
): string {
  const firstMailSource = parts[0]?.source;
  const commonMailSource =
    firstMailSource !== undefined &&
    parts.every((part) => {
      return (
        part.source?.type === "mail" &&
        part.source.id === firstMailSource.id &&
        part.source.status === firstMailSource.status &&
        part.source.sentId === firstMailSource.sentId
      );
    })
      ? firstMailSource
      : null;
  const hasSourceContext = parts.some((part) => {
    return part.source !== undefined;
  });
  const mailSourceLabel = (
    source: NonNullable<
      Extract<UserMessagePart, { type: "feedback" }>["source"]
    >,
  ) => {
    return source.status === "draft"
      ? `an email draft (mail draft ID: ${source.id})`
      : `a sent email (mail ID: ${source.id}${source.sentId ? `, sent ID: ${source.sentId}` : ""})`;
  };
  const blocks = parts.map((part) => {
    const quoted = part.quote
      .split("\n")
      .map((line) => {
        return `> ${line}`;
      })
      .join("\n");
    const source =
      commonMailSource === null && part.source?.type === "mail"
        ? `Source: ${mailSourceLabel(part.source)}\n\n`
        : "";
    return `${source}${quoted}\n\n${serializeFeedbackNote(
      part.note,
      serializeTemplate,
    ).trim()}`;
  });
  const intro = commonMailSource
    ? parts.length === 1
      ? `Feedback on this part of ${mailSourceLabel(commonMailSource)}:`
      : `Feedback on ${parts.length} parts of ${mailSourceLabel(commonMailSource)}:`
    : hasSourceContext
      ? `Feedback on ${parts.length} selected ${parts.length === 1 ? "passage" : "passages"}:`
      : parts.length === 1
        ? "Feedback on this part of your reply:"
        : `Feedback on ${parts.length} parts of your reply:`;
  return `${intro}\n\n${blocks.join("\n\n---\n\n")}`;
}

/**
 * Projects one validated business document into the server-owned runtime
 * representations. Inline template markers stay in authoritative `parts`
 * order, while their selections are also returned for this run's shared
 * template context.
 */
export function projectUserMessage(
  document: UserMessageDocument,
  options: { readonly inlineTemplates?: boolean } = {},
): UserMessageProjection {
  const promptBlocks: string[] = [];
  const displayBlocks: string[] = [];
  let inlinePrompt = "";
  let inlineDisplayText = "";
  let feedbackParts: Extract<UserMessagePart, { type: "feedback" }>[] = [];
  let generationTemplate: GenerationTemplateRequest | undefined;
  const generationTemplates: GenerationTemplateRequest[] = [];
  let hasTextContent = false;

  const registerInlineTemplate = (part: {
    readonly titleSnapshot: string;
    readonly template: GenerationTemplateRequest;
  }): string => {
    generationTemplates.push(part.template);
    generationTemplate ??= part.template;
    return inlineGenerationTemplatePrompt(part, generationTemplates.length);
  };
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
  const flushFeedback = () => {
    if (feedbackParts.length === 0) {
      return;
    }
    const formatted = formatFeedbackParts(
      feedbackParts,
      options.inlineTemplates === true ? registerInlineTemplate : undefined,
    );
    promptBlocks.push(formatted);
    displayBlocks.push(formatted);
    feedbackParts = [];
  };

  for (const part of document.parts) {
    if (part.type === "feedback") {
      flushInlinePrompt();
      feedbackParts.push(part);
      hasTextContent = true;
      continue;
    }
    flushFeedback();
    if (part.type === "text") {
      inlinePrompt += part.text;
      inlineDisplayText += part.text;
      hasTextContent ||= part.text.trim().length > 0;
      continue;
    }
    if (part.type === "chat_thread") {
      const serialized = serializeChatThreadMention(
        part.threadId,
        part.titleSnapshot,
      );
      inlinePrompt += serialized;
      inlineDisplayText += `[Chat thread: ${part.titleSnapshot}]`;
      hasTextContent = true;
      continue;
    }
    if (part.type === "file") {
      flushInlinePrompt();
      promptBlocks.push(webFilePrompt(part));
      displayBlocks.push(`[File: ${part.filenameSnapshot}]`);
      continue;
    }
    if (options.inlineTemplates === true) {
      inlinePrompt += registerInlineTemplate(part);
      inlineDisplayText += `[Template: ${part.titleSnapshot}]`;
      continue;
    }
    flushInlinePrompt();
    promptBlocks.push(generationTemplatePrompt(part));
    displayBlocks.push(`[Template: ${part.titleSnapshot}]`);
    generationTemplate ??= part.template;
    generationTemplates.push(part.template);
  }
  flushFeedback();
  flushInlinePrompt();

  return {
    agentPrompt: promptBlocks.join("\n\n"),
    displayText: displayBlocks.join("\n\n"),
    generationTemplate,
    generationTemplates,
    hasTextContent,
  };
}
