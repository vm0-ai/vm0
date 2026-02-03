import type { WebClient } from "@slack/web-api";

interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
}

/**
 * Fetch thread history from Slack
 *
 * @param client - Slack WebClient
 * @param channel - Channel ID
 * @param threadTs - Thread timestamp
 * @param limit - Maximum number of messages to fetch (default: 20)
 * @returns Array of messages
 */
export async function fetchThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string,
  limit = 20,
): Promise<SlackMessage[]> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit,
  });

  return (result.messages ?? []) as SlackMessage[];
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
 * Format messages into context for agent prompt
 *
 * @param messages - Array of Slack messages
 * @param botUserId - Bot user ID to filter out bot messages (optional)
 * @param contextType - Type of context: "thread" or "channel"
 * @returns Formatted context string
 */
export function formatContextForAgent(
  messages: SlackMessage[],
  botUserId?: string,
  contextType: "thread" | "channel" = "thread",
): string {
  const formattedMessages = messages
    // Filter out bot's own messages if botUserId is provided
    .filter((msg) => !botUserId || msg.user !== botUserId)
    // Format each message
    .map((msg) => {
      const user = msg.user ?? "unknown";
      const text = msg.text ?? "";
      return `[${user}]: ${text}`;
    });

  if (formattedMessages.length === 0) {
    return "";
  }

  const header =
    contextType === "thread"
      ? "## Slack Thread Context"
      : "## Recent Channel Messages";

  return `${header}\n\n${formattedMessages.join("\n\n")}`;
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
