import type { WebClient } from "@slack/web-api";
import { logger } from "../logger";

const log = logger("slack:context");

/** Maximum file size to download and embed as base64 (5MB) */
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** Image MIME types that can be embedded as base64 data URLs */
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

interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
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
 * Download a Slack file using the bot token and return base64 data URL
 * Returns null if download fails or file is too large
 */
async function downloadSlackFileAsBase64(
  file: SlackFile,
  botToken: string,
): Promise<string | null> {
  const downloadUrl = file.url_private_download;
  if (!downloadUrl) {
    log.debug("No url_private_download available", { fileId: file.id });
    return null;
  }

  // Check file size before downloading
  if (file.size && file.size > MAX_FILE_SIZE_BYTES) {
    log.debug("File too large to embed", {
      fileId: file.id,
      size: file.size,
      maxSize: MAX_FILE_SIZE_BYTES,
    });
    return null;
  }

  try {
    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
    });

    if (!response.ok) {
      log.debug("Failed to download Slack file", {
        fileId: file.id,
        status: response.status,
      });
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimetype = file.mimetype || "application/octet-stream";

    return `data:${mimetype};base64,${base64}`;
  } catch (error) {
    log.debug("Error downloading Slack file", { fileId: file.id, error });
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
 * Format file information for context with optional image embedding
 * Downloads and embeds supported image types as base64 data URLs
 */
async function formatFileInfoWithImage(
  file: SlackFile,
  botToken: string | undefined,
): Promise<string> {
  const parts: string[] = [];

  const name = file.name || file.title || "Untitled";
  const type = file.pretty_type || file.mimetype || "file";
  parts.push(`[file]: ${name} (${type})`);

  if (file.original_w && file.original_h) {
    parts.push(`   Dimensions: ${file.original_w}x${file.original_h}`);
  }

  // Try to download and embed image if supported type and bot token available
  if (botToken && isSupportedImageType(file)) {
    const dataUrl = await downloadSlackFileAsBase64(file, botToken);
    if (dataUrl) {
      parts.push(`   Image Data: ${dataUrl}`);
      log.debug("Embedded image as base64", { fileId: file.id, name });
      return parts.join("\n");
    }
  }

  // Fallback to URL reference
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
  }

  return parts.join("\n");
}

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
  // Include all messages (don't filter bot messages)
  const formattedMessages = messages.map((msg) => {
    const user = msg.bot_id ? "bot" : (msg.user ?? "unknown");
    const text = msg.text ?? "";

    const parts: string[] = [`[${user}]: ${text}`];

    // Format files (uploaded images, documents, etc.)
    if (msg.files && msg.files.length > 0) {
      for (const file of msg.files) {
        parts.push(formatFileInfo(file));
      }
    }

    // Format attachments with images (URL unfurls, etc.)
    if (msg.attachments && msg.attachments.length > 0) {
      for (const attachment of msg.attachments) {
        const attachmentInfo = formatAttachmentImage(attachment);
        if (attachmentInfo) {
          parts.push(attachmentInfo);
        }
      }
    }

    return parts.join("\n");
  });

  if (formattedMessages.length === 0) {
    return "";
  }

  const header =
    contextType === "thread"
      ? "## Slack Thread Context"
      : "## Recent Channel Messages";

  const result = `${header}\n\n${formattedMessages.join("\n\n")}`;
  log.debug("Formatted messages for context", {
    messageCount: formattedMessages.length,
    contextType,
    resultLength: result.length,
  });
  return result;
}

/**
 * Format messages into context for agent prompt with image embedding
 * Downloads and embeds supported image types as base64 data URLs
 *
 * @param messages - Array of Slack messages
 * @param botToken - Bot token for downloading private files
 * @param botUserId - Bot user ID (kept for API compatibility, no longer used for filtering)
 * @param contextType - Type of context: "thread" or "channel"
 * @returns Formatted context string with embedded images
 */
export async function formatContextForAgentWithImages(
  messages: SlackMessage[],
  botToken: string,
  botUserId?: string,
  contextType: "thread" | "channel" = "thread",
): Promise<string> {
  // Include all messages (don't filter bot messages)
  const formattedMessages = await Promise.all(
    messages.map(async (msg) => {
      const user = msg.bot_id ? "bot" : (msg.user ?? "unknown");
      const text = msg.text ?? "";

      const parts: string[] = [`[${user}]: ${text}`];

      // Format files with image embedding
      if (msg.files && msg.files.length > 0) {
        for (const file of msg.files) {
          const fileInfo = await formatFileInfoWithImage(file, botToken);
          parts.push(fileInfo);
        }
      }

      // Format attachments with images (URL unfurls - these are usually public)
      if (msg.attachments && msg.attachments.length > 0) {
        for (const attachment of msg.attachments) {
          const attachmentInfo = formatAttachmentImage(attachment);
          if (attachmentInfo) {
            parts.push(attachmentInfo);
          }
        }
      }

      return parts.join("\n");
    }),
  );

  if (formattedMessages.length === 0) {
    return "";
  }

  const header =
    contextType === "thread"
      ? "## Slack Thread Context"
      : "## Recent Channel Messages";

  const result = `${header}\n\n${formattedMessages.join("\n\n")}`;
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

/**
 * Check if message contains explicit agent selection
 * Pattern: "use <agent-name> <message>"
 *
 * @param message - Message content (after removing bot mention)
 * @returns Agent name and remaining message, or null if no explicit selection
 */
export function parseExplicitAgentSelection(
  message: string,
): { agentName: string; remainingMessage: string } | null {
  const match = message.match(/^use\s+(\S+)\s*(.*)/i);
  if (!match || !match[1]) {
    return null;
  }

  return {
    agentName: match[1],
    remainingMessage: (match[2] ?? "").trim(),
  };
}
