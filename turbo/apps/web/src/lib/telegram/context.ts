import { eq, and, desc } from "drizzle-orm";
import { telegramMessages } from "../../db/schema/telegram-message";
import { logger } from "../logger";

const log = logger("telegram:context");

/** Maximum number of recent messages to fetch for context */
const MAX_CONTEXT_MESSAGES = 10;

const CONTEXT_PREAMBLE = [
  "The messages below are from a Telegram conversation. When responding:",
  "- Match the tone of the conversation — casual messages deserve casual replies.",
  "- Only provide technical analysis when explicitly asked a technical question.",
  "- Keep responses proportional to the message length and complexity.",
].join("\n");

interface TelegramContextMessage {
  fromUsername: string | null;
  fromUserId: string;
  text: string | null;
  isBot: boolean;
  messageId: string;
}

/**
 * Fetch recent Telegram messages for a chat and build context strings.
 *
 * @param installationId - Telegram installation ID
 * @param chatId - Telegram chat ID
 * @param lastProcessedMessageId - Only include messages after this ID for execution context
 * @returns routingContext (all recent text) and executionContext (only new messages)
 */
export async function fetchTelegramContext(
  installationId: string,
  chatId: string,
  lastProcessedMessageId?: string,
): Promise<{ routingContext: string; executionContext: string }> {
  const messages = await globalThis.services.db
    .select({
      fromUsername: telegramMessages.fromUsername,
      fromUserId: telegramMessages.fromUserId,
      text: telegramMessages.text,
      isBot: telegramMessages.isBot,
      messageId: telegramMessages.messageId,
    })
    .from(telegramMessages)
    .where(
      and(
        eq(telegramMessages.installationId, installationId),
        eq(telegramMessages.chatId, chatId),
      ),
    )
    .orderBy(desc(telegramMessages.createdAt))
    .limit(MAX_CONTEXT_MESSAGES);

  // Reverse to chronological order (oldest first)
  const chronological = messages.reverse();

  log.debug("Fetched telegram context messages", {
    chatId,
    count: chronological.length,
  });

  const routingContext = formatContextForAgent(chronological);

  // For execution context, only include messages after lastProcessedMessageId
  const executionMessages = lastProcessedMessageId
    ? chronological.filter(
        (m) => Number(m.messageId) > Number(lastProcessedMessageId),
      )
    : chronological;

  const executionContext =
    executionMessages.length > 0
      ? formatContextForAgent(executionMessages)
      : "";

  return { routingContext, executionContext };
}

/**
 * Format message array into agent-readable text
 */
export function formatContextForAgent(
  messages: TelegramContextMessage[],
): string {
  if (messages.length === 0) {
    return "";
  }

  const formatted = messages
    .filter((m) => m.text)
    .map((m) => {
      const sender = m.isBot
        ? "BOT"
        : (m.fromUsername ?? `user:${m.fromUserId}`);
      return `[${sender}]: ${m.text}`;
    })
    .join("\n");

  return `# Telegram Chat Context\n\n${CONTEXT_PREAMBLE}\n\n${formatted}`;
}
