import type { WebClient } from "@slack/web-api";
import { logger } from "../../shared/logger";
import { type SlackUserInfo, formatSenderBlock } from "./client";

const log = logger("slack:context");

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  size?: number;
  original_w?: string;
  original_h?: string;
  thumb_360?: string;
  thumb_480?: string;
  permalink?: string;
  permalink_public?: string;
  url_private_download?: string;
}

interface SlackAttachment {
  image_url?: string;
  image_width?: number;
  image_height?: number;
  thumb_url?: string;
  title?: string;
  fallback?: string;
}

interface RichTextStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

interface RichTextElement {
  type: string;
  text?: string;
  url?: string;
  name?: string;
  unicode?: string;
  user_id?: string;
  usergroup_id?: string;
  channel_id?: string;
  range?: string;
  style?: RichTextStyle | string;
  indent?: number;
  offset?: number;
  language?: string;
  elements?: RichTextElement[];
}

interface SlackBlock {
  type: string;
  elements?: RichTextElement[];
}

interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  blocks?: SlackBlock[];
}

/**
 * Fetch thread history from Slack
 *
 * @param client - Slack WebClient
 * @param channel - Channel ID
 * @param threadTs - Thread timestamp
 * @param limit - Maximum number of messages to fetch (default: 100, fetch all)
 * @returns Array of messages
 */
export async function fetchThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string,
  limit = 100,
): Promise<SlackMessage[]> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit,
  });

  const messages = (result.messages ?? []) as SlackMessage[];
  log.debug("Fetched thread messages", { count: messages.length });
  return messages;
}

/**
 * Fetch recent channel messages from Slack
 *
 * @param client - Slack WebClient
 * @param channel - Channel ID
 * @param limit - Maximum number of messages to fetch (default: 10)
 * @returns Array of messages
 */
export async function fetchChannelContext(
  client: WebClient,
  channel: string,
  limit = 10,
  latest?: string,
): Promise<SlackMessage[]> {
  const result = await client.conversations.history({
    channel,
    limit,
    ...(latest && { latest }),
  });

  // Reverse to get chronological order (oldest first)
  return ((result.messages ?? []) as SlackMessage[]).reverse();
}

/**
 * Apply markdown-like style wrappers to a text element.
 */
function applyTextStyle(
  text: string,
  style: RichTextStyle | string | undefined,
): string {
  if (typeof style === "string" || !style) return text;
  if (style.code) return `\`${text}\``;
  let result = text;
  if (style?.bold) result = `**${result}**`;
  if (style?.italic) result = `_${result}_`;
  if (style?.strike) result = `~${result}~`;
  return result;
}

/**
 * Convert an inline rich text element to plain text with markdown-like formatting.
 */
function formatInlineElement(el: RichTextElement): string {
  switch (el.type) {
    case "text":
      return applyTextStyle(el.text ?? "", el.style);
    case "link":
      return el.url ? `[${el.text ?? el.url}](${el.url})` : (el.text ?? "");
    case "emoji":
      return el.unicode
        ? String.fromCodePoint(
            ...el.unicode.split("-").map((h) => {
              return parseInt(h, 16);
            }),
          )
        : `:${el.name ?? "emoji"}:`;
    case "user":
      return `<@${el.user_id ?? "unknown"}>`;
    case "usergroup":
      return `<!subteam^${el.usergroup_id ?? "unknown"}>`;
    case "channel":
      return `<#${el.channel_id ?? "unknown"}>`;
    case "broadcast":
      return `@${el.range ?? "here"}`;
    default:
      return el.text ?? "";
  }
}

/**
 * Convert an array of inline elements to a single text string.
 */
function inlineElementsToText(elements: RichTextElement[]): string {
  return elements.map(formatInlineElement).join("");
}

/**
 * Extract plain text content from Slack rich_text blocks.
 * Returns undefined when no rich_text blocks are present so callers
 * can fall back to msg.text.
 */
export function extractTextFromBlocks(
  blocks: SlackBlock[] | undefined,
): string | undefined {
  if (!blocks || blocks.length === 0) return undefined;

  const richTextBlocks = blocks.filter((b) => {
    return b.type === "rich_text";
  });
  if (richTextBlocks.length === 0) return undefined;

  const parts: string[] = [];

  for (const block of richTextBlocks) {
    for (const section of block.elements ?? []) {
      switch (section.type) {
        case "rich_text_section":
          parts.push(inlineElementsToText(section.elements ?? []));
          break;
        case "rich_text_list": {
          const items = section.elements ?? [];
          const indent = "  ".repeat(section.indent ?? 0);
          items.forEach((item, i) => {
            const listStyle =
              typeof section.style === "string" ? section.style : undefined;
            const bullet =
              listStyle === "ordered"
                ? `${(section.offset ?? 0) + i + 1}.`
                : "-";
            const text = inlineElementsToText(item.elements ?? []);
            parts.push(`${indent}${bullet} ${text}`);
          });
          break;
        }
        case "rich_text_preformatted": {
          const code = inlineElementsToText(section.elements ?? []);
          const lang = section.language ?? "";
          parts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
          break;
        }
        case "rich_text_quote":
          parts.push(
            (section.elements ?? [])
              .map((el) => {
                return formatInlineElement(el);
              })
              .join("")
              .split("\n")
              .map((line) => {
                return `> ${line}`;
              })
              .join("\n"),
          );
          break;
        default:
          break;
      }
    }
  }

  const result = parts.join("\n");
  return result.length > 0 ? result : undefined;
}

function isVideoMimeType(mimetype: string | undefined): boolean {
  if (!mimetype) return false;
  return mimetype.startsWith("video/");
}

/**
 * Format a Slack file reference for the agent prompt.
 *
 * Emits a three-step instruction block that guides the agent to:
 *   1. Download via `zero slack download-file`
 *   2. (videos only) Extract frames with ffmpeg
 *   3. Read the file using the appropriate tool
 *
 * The file is NOT fetched server-side; the agent pulls bytes on demand
 * through the bot-token-authenticated backend proxy.
 */
function formatFileInfo(file: SlackFile): string {
  const parts: string[] = [];

  const name = file.name || file.title || "Untitled";
  const type = file.pretty_type || file.mimetype || "file";
  parts.push(`[file]: ${name} (${type})`);

  if (file.original_w && file.original_h) {
    parts.push(`   Dimensions: ${file.original_w}x${file.original_h}`);
  }

  if (!file.id) {
    // Without a file id the agent cannot fetch via the backend proxy.
    // Fall back to an informational URL reference if available.
    const url =
      file.permalink_public ||
      file.thumb_480 ||
      file.thumb_360 ||
      file.permalink;
    if (url) {
      parts.push(`   URL: ${url}`);
    }
    return parts.join("\n");
  }

  const ext = file.filetype || "bin";
  const localPath = `/tmp/${file.id}.${ext}`;

  parts.push(
    `   Step 1 - Download: zero slack download-file ${file.id} -o ${localPath}`,
  );

  if (isVideoMimeType(file.mimetype)) {
    const framePattern = `/tmp/${file.id}_frame_%03d.jpg`;
    parts.push(
      `   Step 2 - Extract frames: ffmpeg -i ${localPath} -vf "fps=1" -q:v 2 ${framePattern}`,
    );
    parts.push(
      `   Step 3 - Read: view the extracted frames to understand the video content`,
    );
  } else {
    parts.push(`   Step 2 - Read: open ${localPath} with the appropriate tool`);
  }

  return parts.join("\n");
}

/**
 * Format attachment with image for context (URL unfurl, not an uploaded file).
 * Attachments are external images referenced in the message — they use a
 * different mechanism than uploaded SlackFiles and stay on curl.
 */
function formatAttachmentImage(attachment: SlackAttachment): string | null {
  if (!attachment.image_url && !attachment.thumb_url) {
    return null;
  }

  const parts: string[] = [];
  const title = attachment.title || attachment.fallback || "Image";
  parts.push(`[image]: ${title}`);

  if (attachment.image_width && attachment.image_height) {
    parts.push(
      `   Dimensions: ${attachment.image_width}x${attachment.image_height}`,
    );
  }

  const url = attachment.image_url || attachment.thumb_url;
  if (url) {
    parts.push(
      `   View: curl -sS -o /tmp/attachment_image.jpg "${url}" && read /tmp/attachment_image.jpg`,
    );
  }

  return parts.join("\n");
}

/**
 * Resolve user mentions in text using the user info map.
 * Replaces `<@U12345>` with `@Name (U12345)` when user info is available.
 */
export function resolveUserMentions(
  text: string,
  userInfoMap?: Map<string, SlackUserInfo>,
): string {
  if (!userInfoMap || userInfoMap.size === 0) return text;
  return text.replace(/<@(\w+)>/g, (_match, userId: string) => {
    const info = userInfoMap.get(userId);
    return info?.name ? `@${info.name} (${userId})` : `<@${userId}>`;
  });
}

/**
 * Extract all user IDs mentioned in messages (from rich_text blocks and plain text).
 */
export function extractMentionedUserIds(messages: SlackMessage[]): string[] {
  const ids = new Set<string>();
  for (const msg of messages) {
    // From rich_text blocks
    if (msg.blocks) {
      for (const block of msg.blocks) {
        for (const section of block.elements ?? []) {
          for (const el of section.elements ?? []) {
            if (el.type === "user" && el.user_id) {
              ids.add(el.user_id);
            }
          }
        }
      }
    }
    // From plain text fallback
    if (msg.text) {
      for (const match of msg.text.matchAll(/<@(\w+)>/g)) {
        const userId = match[1];
        if (userId) ids.add(userId);
      }
    }
  }
  return [...ids];
}

/**
 * Format a single message with structured metadata
 */
function formatMessageWithMetadata(
  msg: SlackMessage,
  relativeIndex: number,
  fileParts: string[],
  userInfoMap?: Map<string, SlackUserInfo>,
): string {
  const senderId = msg.bot_id ? "BOT" : (msg.user ?? "unknown");
  const userInfo = userInfoMap?.get(senderId);
  const senderBlock = formatSenderBlock(userInfo ?? { id: senderId });
  const rawText = extractTextFromBlocks(msg.blocks) ?? msg.text ?? "";
  const text = resolveUserMentions(rawText, userInfoMap);

  const parts: string[] = [
    "---",
    "",
    `- RELATIVE_INDEX: ${relativeIndex}`,
    senderBlock,
    "",
    text,
  ];

  if (fileParts.length > 0) {
    parts.push(...fileParts);
  }

  return parts.join("\n");
}

const CONTEXT_PREAMBLE = [
  "The messages below are from a Slack conversation. When responding:",
  "- Messages closer to RELATIVE_INDEX 0 are more recent — prioritize them.",
  "- Match the tone of the conversation — casual messages deserve casual replies.",
  "- Only provide technical analysis when explicitly asked a technical question.",
  "- Keep responses proportional to the message length and complexity.",
  "- When a message includes a [file] block, follow the numbered Step instructions to download and read the file before responding about its contents.",
].join("\n");

/**
 * Format messages into context for the agent prompt.
 *
 * File attachments are rendered with three-step instructions that point the
 * agent at `zero slack download-file <id>`; no bytes are fetched here.
 *
 * @param messages - Array of Slack messages
 * @param contextType - Type of context: "thread" or "channel"
 * @param userInfoMap - Pre-resolved map of Slack user ID → user info
 */
export function formatContextForAgent(
  messages: SlackMessage[],
  contextType: "thread" | "channel" = "thread",
  userInfoMap?: Map<string, SlackUserInfo>,
): string {
  if (messages.length === 0) {
    return "";
  }

  const totalMessages = messages.length;

  const formattedMessages = messages.map((msg, index) => {
    const relativeIndex = index - totalMessages;

    const fileParts: string[] = [];

    // Format uploaded Slack files — agent fetches via `zero slack download-file`
    if (msg.files && msg.files.length > 0) {
      for (const file of msg.files) {
        fileParts.push(formatFileInfo(file));
      }
    }

    // Format attachments with images (URL unfurls — usually public)
    if (msg.attachments && msg.attachments.length > 0) {
      for (const attachment of msg.attachments) {
        const attachmentInfo = formatAttachmentImage(attachment);
        if (attachmentInfo) {
          fileParts.push(attachmentInfo);
        }
      }
    }

    return formatMessageWithMetadata(
      msg,
      relativeIndex,
      fileParts,
      userInfoMap,
    );
  });

  const header =
    contextType === "thread"
      ? "# Slack Thread Context"
      : "# Recent Channel Messages";

  const result = `${header}\n\n${CONTEXT_PREAMBLE}\n\n${formattedMessages.join("\n\n")}\n\n---`;
  log.debug("Formatted messages for context", {
    messageCount: formattedMessages.length,
    contextType,
    resultLength: result.length,
  });
  return result;
}

/**
 * Format files attached to the current message for inclusion in the prompt.
 */
export function formatCurrentMessageFiles(files: SlackFile[]): string {
  const parts: string[] = [];
  for (const file of files) {
    parts.push(formatFileInfo(file));
  }
  return parts.join("\n");
}

/**
 * Extract the actual message content from a Slack @mention
 * Removes the bot mention from the beginning of the message
 *
 * @param text - Raw message text
 * @param botUserId - Bot user ID
 * @returns Message without the mention
 */
export function extractMessageContent(text: string, botUserId: string): string {
  // Slack mentions look like: <@U12345678> message
  // Escape botUserId to prevent ReDoS from non-literal RegExp
  const escapedId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`^<@${escapedId}>\\s*`, "i");
  return text.replace(mentionPattern, "").trim();
}
