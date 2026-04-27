import { eq, and, desc } from "drizzle-orm";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import {
  downloadAndUploadTelegramPhoto,
  formatPhotoForContext,
} from "./images";
import type { TelegramClient } from "./client";
import { logger } from "../../shared/logger";

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
  fileId: string | null;
  isBot: boolean;
  messageId: string;
}

/**
 * Fetch recent Telegram messages for a chat and build execution context.
 *
 * @param installationId - Telegram installation ID
 * @param chatId - Telegram chat ID
 * @param lastProcessedMessageId - Only include messages after this ID for execution context
 * @param client - Telegram client (needed to download images for execution context)
 * @param currentMessageId - The message being processed; excluded from context to avoid duplication with prompt
 * @returns executionContext (only new messages, with images)
 */
export async function fetchTelegramContext(
  installationId: string,
  chatId: string,
  lastProcessedMessageId?: string,
  client?: TelegramClient,
  currentMessageId?: string,
): Promise<{ executionContext: string }> {
  const messages = await globalThis.services.db
    .select({
      fromUsername: telegramMessages.fromUsername,
      fromUserId: telegramMessages.fromUserId,
      text: telegramMessages.text,
      fileId: telegramMessages.fileId,
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
  // Exclude the current message to avoid duplication with the user prompt
  const chronological = messages.reverse().filter((m) => {
    return !currentMessageId || m.messageId !== currentMessageId;
  });

  log.debug("Fetched telegram context messages", {
    chatId,
    count: chronological.length,
  });

  // For execution context, only include messages after lastProcessedMessageId
  const executionMessages = lastProcessedMessageId
    ? chronological.filter((m) => {
        return Number(m.messageId) > Number(lastProcessedMessageId);
      })
    : chronological;

  // Execution context: include images (download + upload to R2)
  const executionContext =
    executionMessages.length > 0
      ? await formatContextForAgentWithImages(
          executionMessages,
          client,
          `${installationId}-${chatId}`,
        )
      : "";

  return { executionContext };
}

/**
 * Format a single message with structured metadata.
 *
 * Mirrors the Slack context format so the agent sees a consistent
 * structure across integrations:
 *
 * ---
 *
 * - RELATIVE_INDEX: -n
 * - MSG_ID: 12345
 * - SENDER_ID: username | user:id | BOT
 *
 * message text
 */
function formatMessageWithMetadata(
  msg: TelegramContextMessage,
  relativeIndex: number,
  imageParts?: string[],
): string {
  const senderId = msg.isBot
    ? "BOT"
    : (msg.fromUsername ?? `user:${msg.fromUserId}`);

  const parts: string[] = [
    "---",
    "",
    `- RELATIVE_INDEX: ${relativeIndex}`,
    `- MSG_ID: ${msg.messageId}`,
    `- SENDER_ID: ${senderId}`,
    "",
    msg.text ?? "",
  ];

  if (imageParts && imageParts.length > 0) {
    parts.push(...imageParts);
  }

  return parts.join("\n");
}

/**
 * Format message array with image downloads (for execution context).
 * Downloads photos via Telegram API and uploads to R2 for agent access.
 */
async function formatContextForAgentWithImages(
  messages: TelegramContextMessage[],
  client: TelegramClient | undefined,
  sessionId: string,
): Promise<string> {
  if (messages.length === 0) {
    return "";
  }

  const totalMessages = messages.length;

  const formattedMessages = await Promise.all(
    messages
      .filter((m) => {
        return m.text || m.fileId;
      })
      .map(async (msg, index) => {
        const relativeIndex = index - totalMessages;
        const imageParts: string[] = [];

        if (msg.fileId && client) {
          const presignedUrl = await downloadAndUploadTelegramPhoto(
            client,
            msg.fileId,
            sessionId,
          );
          if (presignedUrl) {
            imageParts.push(
              formatPhotoForContext(presignedUrl, {
                file_id: msg.fileId,
                width: 0,
                height: 0,
              }),
            );
          } else {
            imageParts.push("[image]: photo (failed to download)");
          }
        } else if (msg.fileId) {
          imageParts.push("[image]: photo (no client available)");
        }

        return formatMessageWithMetadata(msg, relativeIndex, imageParts);
      }),
  );

  const result = `# Telegram Chat Context\n\n${CONTEXT_PREAMBLE}\n\n${formattedMessages.join("\n\n")}\n\n---`;
  log.debug("Formatted messages for context with images", {
    messageCount: formattedMessages.length,
    resultLength: result.length,
  });
  return result;
}
