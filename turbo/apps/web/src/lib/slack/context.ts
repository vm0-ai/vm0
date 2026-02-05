import type { WebClient } from "@slack/web-api";
import { logger } from "../logger";

const log = logger("slack:context");

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
 * Format file information for context
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
 * Format messages into context for agent prompt
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
