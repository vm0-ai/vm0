import type { WebClient } from "@slack/web-api";
import { logger } from "../logger";
import { uploadS3Buffer, generatePresignedUrl } from "../s3/s3-client";
import { env } from "../../env";

const log = logger("slack:context");

/** Maximum file size to download and upload (10MB) */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Image MIME types that can be uploaded for agent access */
const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
];

interface SlackFile {
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
): Promise<SlackMessage[]> {
  const result = await client.conversations.history({
    channel,
    limit,
  });

  // Reverse to get chronological order (oldest first)
  return ((result.messages ?? []) as SlackMessage[]).reverse();
}

/**
 * Check if a file is a supported image type
 */
function isSupportedImageType(file: SlackFile): boolean {
  const mimetype = file.mimetype?.toLowerCase();
  return mimetype !== undefined && SUPPORTED_IMAGE_TYPES.includes(mimetype);
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
            ...el.unicode.split("-").map((h) => parseInt(h, 16)),
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

  const richTextBlocks = blocks.filter((b) => b.type === "rich_text");
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
              .map((el) => formatInlineElement(el))
              .join("")
              .split("\n")
              .map((line) => `> ${line}`)
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

/**
 * Download a Slack file and upload to R2 temporary storage
 * Returns a presigned URL that Claude Code can access directly
 */
async function downloadAndUploadSlackFile(
  file: SlackFile,
  botToken: string,
  sessionId: string,
): Promise<string | null> {
  const downloadUrl = file.url_private_download;
  if (!downloadUrl) {
    log.debug("No url_private_download available", { fileId: file.id });
    return null;
  }

  // Check file size before downloading
  if (file.size && file.size > MAX_FILE_SIZE_BYTES) {
    log.debug("File too large to upload", {
      fileId: file.id,
      size: file.size,
      maxSize: MAX_FILE_SIZE_BYTES,
    });
    return null;
  }

  try {
    log.debug("Downloading Slack file", {
      fileId: file.id,
      downloadUrl,
    });

    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
    });

    log.debug("Slack download response", {
      fileId: file.id,
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
    });

    if (!response.ok) {
      log.debug("Failed to download Slack file", {
        fileId: file.id,
        status: response.status,
      });
      return null;
    }

    // Verify the response content type is an image
    const responseContentType = response.headers.get("content-type");
    if (!responseContentType || !responseContentType.startsWith("image/")) {
      log.debug("Slack returned non-image content", {
        fileId: file.id,
        contentType: responseContentType,
      });
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Verify the content is actually an image (check magic bytes)
    // PNG: 89 50 4E 47, JPEG: FF D8 FF, GIF: 47 49 46, WebP: 52 49 46 46
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    const isGif = buffer[0] === 0x47 && buffer[1] === 0x49;
    const isWebp = buffer[0] === 0x52 && buffer[1] === 0x49;

    if (!isPng && !isJpeg && !isGif && !isWebp) {
      log.debug("Downloaded content is not a valid image", {
        fileId: file.id,
        firstBytes: buffer.slice(0, 10).toString("hex"),
      });
      return null;
    }

    // Upload to R2 temporary storage with correct MIME type
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
    const filename = file.name || file.id || "image";
    const s3Key = `slack-images/${sessionId}/${file.id || Date.now()}-${filename}`;
    const contentType = file.mimetype || "application/octet-stream";

    await uploadS3Buffer(bucketName, s3Key, buffer, contentType);

    // Generate presigned URL (valid for 1 hour)
    const presignedUrl = await generatePresignedUrl(bucketName, s3Key, 3600);

    log.debug("Uploaded Slack image to R2", {
      fileId: file.id,
      name: filename,
      size: buffer.length,
      s3Key,
      presignedUrl,
    });

    return presignedUrl;
  } catch (error) {
    log.debug("Error downloading/uploading Slack file", {
      fileId: file.id,
      error,
    });
    return null;
  }
}

/**
 * Format file information for context (sync version, metadata only)
 */
function formatFileInfo(file: SlackFile): string {
  const parts: string[] = [];

  const name = file.name || file.title || "Untitled";
  const type = file.pretty_type || file.mimetype || "file";
  parts.push(`[file]: ${name} (${type})`);

  if (file.original_w && file.original_h) {
    parts.push(`   Dimensions: ${file.original_w}x${file.original_h}`);
  }

  const url =
    file.permalink_public || file.thumb_480 || file.thumb_360 || file.permalink;
  if (url) {
    parts.push(`   URL: ${url}`);
  }

  return parts.join("\n");
}

/**
 * Format file information for context with image upload to R2
 * Uploads supported image types to R2 and provides presigned URLs
 */
async function formatFileInfoWithImage(
  file: SlackFile,
  botToken: string | undefined,
  sessionId: string,
): Promise<string> {
  const parts: string[] = [];

  const name = file.name || file.title || "Untitled";
  const type = file.pretty_type || file.mimetype || "file";
  parts.push(`[file]: ${name} (${type})`);

  if (file.original_w && file.original_h) {
    parts.push(`   Dimensions: ${file.original_w}x${file.original_h}`);
  }

  // Try to upload image to R2 and get presigned URL
  if (botToken && isSupportedImageType(file)) {
    const presignedUrl = await downloadAndUploadSlackFile(
      file,
      botToken,
      sessionId,
    );
    if (presignedUrl) {
      parts.push(`   Image URL: ${presignedUrl}`);
      parts.push(
        `   To view this image, download it with: curl -sS -o /tmp/${file.id || "image"}.${file.filetype || "png"} "${presignedUrl}" && read the downloaded file`,
      );
      return parts.join("\n");
    }
  }

  // Fallback to original URL reference (may not be accessible)
  const url =
    file.permalink_public || file.thumb_480 || file.thumb_360 || file.permalink;
  if (url) {
    parts.push(`   URL: ${url}`);
  }

  return parts.join("\n");
}

/**
 * Format attachment with image for context
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
    parts.push(`   URL: ${url}`);
    parts.push(
      `   To view this image, download it with: curl -sS -o /tmp/attachment_image.jpg "${url}" && read the downloaded file`,
    );
  }

  return parts.join("\n");
}

/**
 * Format a single message with structured metadata
 */
function formatMessageWithMetadata(
  msg: SlackMessage,
  relativeIndex: number,
  fileParts: string[],
): string {
  const senderId = msg.bot_id ? "BOT" : (msg.user ?? "unknown");
  const msgId = msg.ts ?? "unknown";
  const text = extractTextFromBlocks(msg.blocks) ?? msg.text ?? "";

  const parts: string[] = [
    "---",
    "",
    `- RELATIVE_INDEX: ${relativeIndex}`,
    `- MSG_ID: ${msgId}`,
    `- SENDER_ID: ${senderId}`,
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
  "- Match the tone of the conversation — casual messages deserve casual replies.",
  "- Only provide technical analysis when explicitly asked a technical question.",
  "- Keep responses proportional to the message length and complexity.",
].join("\n");

/**
 * Format messages into context for agent prompt (sync version, metadata only)
 *
 * @param messages - Array of Slack messages
 * @param botUserId - Bot user ID (kept for API compatibility, no longer used for filtering)
 * @param contextType - Type of context: "thread" or "channel"
 * @returns Formatted context string
 */
export function formatContextForAgent(
  messages: SlackMessage[],
  botUserId?: string,
  contextType: "thread" | "channel" = "thread",
): string {
  if (messages.length === 0) {
    return "";
  }

  const totalMessages = messages.length;

  // Include all messages (don't filter bot messages)
  const formattedMessages = messages.map((msg, index) => {
    const relativeIndex = index - totalMessages;

    const fileParts: string[] = [];

    // Format files (uploaded images, documents, etc.)
    if (msg.files && msg.files.length > 0) {
      for (const file of msg.files) {
        fileParts.push(formatFileInfo(file));
      }
    }

    // Format attachments with images (URL unfurls, etc.)
    if (msg.attachments && msg.attachments.length > 0) {
      for (const attachment of msg.attachments) {
        const attachmentInfo = formatAttachmentImage(attachment);
        if (attachmentInfo) {
          fileParts.push(attachmentInfo);
        }
      }
    }

    return formatMessageWithMetadata(msg, relativeIndex, fileParts);
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
 * Format messages into context for agent prompt with image upload
 * Uploads supported image types to R2 and provides presigned URLs
 *
 * @param messages - Array of Slack messages
 * @param botToken - Bot token for downloading private files
 * @param sessionId - Session ID for organizing uploaded images
 * @param botUserId - Bot user ID (kept for API compatibility, no longer used for filtering)
 * @param contextType - Type of context: "thread" or "channel"
 * @returns Formatted context string with image URLs
 */
export async function formatContextForAgentWithImages(
  messages: SlackMessage[],
  botToken: string,
  sessionId: string,
  botUserId?: string,
  contextType: "thread" | "channel" = "thread",
): Promise<string> {
  if (messages.length === 0) {
    return "";
  }

  const totalMessages = messages.length;

  // Include all messages (don't filter bot messages)
  const formattedMessages = await Promise.all(
    messages.map(async (msg, index) => {
      const relativeIndex = index - totalMessages;

      const fileParts: string[] = [];

      // Format files with image upload
      if (msg.files && msg.files.length > 0) {
        for (const file of msg.files) {
          const fileInfo = await formatFileInfoWithImage(
            file,
            botToken,
            sessionId,
          );
          fileParts.push(fileInfo);
        }
      }

      // Format attachments with images (URL unfurls - these are usually public)
      if (msg.attachments && msg.attachments.length > 0) {
        for (const attachment of msg.attachments) {
          const attachmentInfo = formatAttachmentImage(attachment);
          if (attachmentInfo) {
            fileParts.push(attachmentInfo);
          }
        }
      }

      return formatMessageWithMetadata(msg, relativeIndex, fileParts);
    }),
  );

  const header =
    contextType === "thread"
      ? "# Slack Thread Context"
      : "# Recent Channel Messages";

  const result = `${header}\n\n${CONTEXT_PREAMBLE}\n\n${formattedMessages.join("\n\n")}\n\n---`;
  log.debug("Formatted messages for context with images", {
    messageCount: formattedMessages.length,
    contextType,
    resultLength: result.length,
  });
  return result;
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
  const mentionPattern = new RegExp(`^<@${botUserId}>\\s*`, "i");
  return text.replace(mentionPattern, "").trim();
}
