import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  userMessageDocumentSchema,
  type GenerationTemplateRequest,
  type GenerationTemplateType,
  type PersistedAttachment,
  type UserMessageDocument,
  type UserMessagePart,
} from "@vm0/api-contracts/contracts/chat-threads";

import { serializeChatThreadMention } from "./chat-thread-suggestion-domain.ts";

export const CHAT_THREAD_MENTION_NODE_NAME = "chatThreadMention";
export const TEMPLATE_ATTACHMENT_NODE_NAME = "templateAttachment";

export interface EditorDocumentContext {
  readonly generationTemplate?: GenerationTemplateRequest;
  readonly attachments?: readonly PersistedAttachment[];
}

export interface EditorDocumentSnapshot {
  readonly toMessageDocument: (
    context?: EditorDocumentContext,
  ) => UserMessageDocument | null;
}

export interface TextMessageTemplateSnapshot {
  readonly titleSnapshot: string;
  readonly template: GenerationTemplateRequest;
}

function appendTextPart(parts: UserMessagePart[], text: string): void {
  if (text.length === 0) {
    return;
  }
  const previous = parts.at(-1);
  if (previous?.type === "text") {
    parts[parts.length - 1] = {
      type: "text",
      text: previous.text + text,
    };
    return;
  }
  parts.push({ type: "text", text });
}

function chatThreadPart(node: ProseMirrorNode): UserMessagePart | null {
  const threadId: unknown = node.attrs.threadId;
  const title: unknown = node.attrs.title;
  if (typeof threadId !== "string" || typeof title !== "string") {
    return null;
  }
  return {
    type: "chat_thread",
    threadId,
    titleSnapshot: title,
  };
}

function templatePart(
  node: ProseMirrorNode,
  generationTemplate: GenerationTemplateRequest | undefined,
): UserMessagePart | null {
  const templateType: unknown = node.attrs.templateType;
  const title: unknown = node.attrs.title;
  if (
    generationTemplate === undefined ||
    templateType !== generationTemplate.type ||
    typeof title !== "string"
  ) {
    return null;
  }
  return {
    type: "template",
    titleSnapshot: title,
    template: generationTemplate,
  };
}

function appendParagraphParts(
  paragraph: ProseMirrorNode,
  parts: UserMessagePart[],
): boolean {
  for (let index = 0; index < paragraph.childCount; index++) {
    const node = paragraph.child(index);
    if (node.isText) {
      if (typeof node.text !== "string") {
        return false;
      }
      appendTextPart(parts, node.text);
      continue;
    }
    if (node.type.name === "hardBreak") {
      appendTextPart(parts, "\n");
      continue;
    }
    if (node.type.name === CHAT_THREAD_MENTION_NODE_NAME) {
      const part = chatThreadPart(node);
      if (!part) {
        return false;
      }
      parts.push(part);
      continue;
    }
    return false;
  }
  return true;
}

function appendFileParts(
  parts: UserMessagePart[],
  attachments: readonly PersistedAttachment[],
): void {
  for (const attachment of attachments) {
    parts.push({
      type: "file",
      fileId: attachment.id,
      filenameSnapshot: attachment.filename,
      contentType: attachment.contentType,
    });
  }
}

/**
 * Converts the current composer snapshot into its editor-independent business
 * document. External files are normalized after the leading template chip and
 * before the text body, matching their current composer presentation order.
 */
export function editorDocToMessageDocument(
  document: ProseMirrorNode,
  context: EditorDocumentContext = {},
): UserMessageDocument | null {
  if (document.type.name !== "doc") {
    return null;
  }

  const parts: UserMessagePart[] = [];
  const attachments = context.attachments ?? [];
  let filesAppended = false;
  let templateCount = 0;
  let paragraphCount = 0;
  for (let index = 0; index < document.childCount; index++) {
    const node = document.child(index);
    if (node.type.name === "paragraph") {
      paragraphCount += 1;
      continue;
    }
    if (node.type.name !== TEMPLATE_ATTACHMENT_NODE_NAME) {
      return null;
    }
    templateCount += 1;
  }
  if (templateCount > 1) {
    return null;
  }

  let paragraphIndex = 0;
  for (let index = 0; index < document.childCount; index++) {
    const node = document.child(index);
    if (node.type.name === TEMPLATE_ATTACHMENT_NODE_NAME) {
      const part = templatePart(node, context.generationTemplate);
      if (!part) {
        return null;
      }
      parts.push(part);
      continue;
    }
    if (!filesAppended) {
      appendFileParts(parts, attachments);
      filesAppended = true;
    }
    if (!appendParagraphParts(node, parts)) {
      return null;
    }
    paragraphIndex += 1;
    if (paragraphIndex < paragraphCount) {
      appendTextPart(parts, "\n");
    }
  }
  if (!filesAppended) {
    appendFileParts(parts, attachments);
  }
  if (templateCount === 0 && context.generationTemplate !== undefined) {
    return null;
  }

  const parsed = userMessageDocumentSchema.safeParse({ version: 1, parts });
  return parsed.success ? parsed.data : null;
}

/**
 * Freezes the immutable ProseMirror document selected for one submission while
 * allowing external attachment ids to be supplied after upload/model filtering
 * settles. The returned value never crosses an API or persistence boundary.
 */
export function createEditorDocumentSnapshot(
  document: ProseMirrorNode,
): EditorDocumentSnapshot {
  return Object.freeze({
    toMessageDocument(context: EditorDocumentContext = {}) {
      return editorDocToMessageDocument(document, context);
    },
  });
}

/** Creates the business document for sends that do not originate in Tiptap. */
export function textToMessageDocument(
  text: string,
  template?: TextMessageTemplateSnapshot,
): UserMessageDocument | null {
  const parts: UserMessagePart[] = [];
  if (template) {
    parts.push({
      type: "template",
      titleSnapshot: template.titleSnapshot,
      template: template.template,
    });
  }
  appendTextPart(parts, text);
  const parsed = userMessageDocumentSchema.safeParse({ version: 1, parts });
  return parsed.success ? parsed.data : null;
}

function templateCategory(type: GenerationTemplateType): string {
  return type === "presentation" ? "slides" : type;
}

function templatePreviewImageUrl(
  template: GenerationTemplateRequest,
): string | null {
  return template.type === "presentation"
    ? (template.selection.previewUrl ?? null)
    : null;
}

function templateNode(part: Extract<UserMessagePart, { type: "template" }>) {
  return {
    type: TEMPLATE_ATTACHMENT_NODE_NAME,
    attrs: {
      templateType: part.template.type,
      title: part.titleSnapshot,
      category: templateCategory(part.template.type),
      previewImageUrl: templatePreviewImageUrl(part.template),
    },
  } satisfies JSONContent;
}

/**
 * Restores the editor-owned portion of a business document. File parts stay in
 * the existing external attachment state and therefore do not become Tiptap
 * nodes. Newlines are canonically restored as paragraph boundaries.
 */
export function messageDocumentToEditorDoc(value: unknown): JSONContent | null {
  const parsed = userMessageDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const content: JSONContent[] = [];
  let paragraphContent: JSONContent[] = [];
  let trailingParagraph = false;
  let templateCount = 0;
  const flushParagraph = () => {
    content.push(
      paragraphContent.length > 0
        ? { type: "paragraph", content: paragraphContent }
        : { type: "paragraph" },
    );
    paragraphContent = [];
    trailingParagraph = false;
  };

  for (const part of parsed.data.parts) {
    if (part.type === "text") {
      const lines = part.text.split("\n");
      for (const [index, line] of lines.entries()) {
        if (line.length > 0) {
          paragraphContent.push({ type: "text", text: line });
          trailingParagraph = false;
        }
        if (index < lines.length - 1) {
          flushParagraph();
          trailingParagraph = true;
        }
      }
      continue;
    }
    if (part.type === "chat_thread") {
      paragraphContent.push({
        type: CHAT_THREAD_MENTION_NODE_NAME,
        attrs: {
          threadId: part.threadId,
          title: part.titleSnapshot,
        },
      });
      trailingParagraph = false;
      continue;
    }
    if (part.type === "template") {
      templateCount += 1;
      if (templateCount > 1) {
        return null;
      }
      if (paragraphContent.length > 0) {
        flushParagraph();
      }
      content.push(templateNode(part));
    }
  }

  if (paragraphContent.length > 0 || trailingParagraph) {
    flushParagraph();
  }
  if (content.length === 0) {
    content.push({ type: "paragraph" });
  }
  return { type: "doc", content };
}

/** Serializes the business document to the same plain prompt representation. */
export function messageDocumentToPrompt(value: unknown): string | null {
  const parsed = userMessageDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "chat_thread") {
        return serializeChatThreadMention(part.threadId, part.titleSnapshot);
      }
      return "";
    })
    .join("");
}

/** Serializes the business document into a compact human-readable label. */
export function messageDocumentToDisplayText(value: unknown): string | null {
  const parsed = userMessageDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const blocks: string[] = [];
  let inlineText = "";
  const flushInlineText = () => {
    if (inlineText.length > 0) {
      blocks.push(inlineText);
      inlineText = "";
    }
  };

  for (const part of parsed.data.parts) {
    if (part.type === "text") {
      inlineText += part.text;
      continue;
    }
    if (part.type === "chat_thread") {
      inlineText += `[Chat thread: ${part.titleSnapshot}]`;
      continue;
    }

    flushInlineText();
    blocks.push(
      part.type === "template"
        ? `[Template: ${part.titleSnapshot}]`
        : `[File: ${part.filenameSnapshot}]`,
    );
  }
  flushInlineText();
  return blocks.join("\n\n");
}
