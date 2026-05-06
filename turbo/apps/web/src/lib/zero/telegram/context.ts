import { eq, and, desc } from "drizzle-orm";
import {
  telegramMessages,
  type TelegramMessageEntity,
} from "@vm0/db/schema/telegram-message";
import { formatTelegramEntitiesForContext } from "./entities";
import {
  formatTelegramFileForContext,
  type TelegramFileContext,
} from "./images";
import type { TelegramClient } from "./client";
import { logger } from "../../shared/logger";
import { OFFICIAL_TELEGRAM_BOT_ID } from "./official";
import type { TelegramMessageScope } from "./handlers/shared";

const log = logger("telegram:context");

/** Maximum number of recent messages to fetch for context */
const MAX_CONTEXT_MESSAGES = 10;

const CONTEXT_PREAMBLE = [
  "The messages below are from a Telegram conversation. When responding:",
  "- Messages closer to RELATIVE_INDEX 0 are more recent — prioritize them.",
  "- Match the tone of the conversation — casual messages deserve casual replies.",
  "- Only provide technical analysis when explicitly asked a technical question.",
  "- Keep responses proportional to the message length and complexity.",
].join("\n");

interface TelegramContextMessage {
  fromUsername: string | null;
  fromDisplayName: string | null;
  fromUserId: string;
  text: string | null;
  fileId: string | null;
  fileType: string | null;
  fileName: string | null;
  fileMimeType: string | null;
  fileSize: number | null;
  fileWidth: number | null;
  fileHeight: number | null;
  fileDuration: number | null;
  entities: TelegramMessageEntity[] | null;
  isBot: boolean;
  messageId: string;
}

function normalizeTelegramContextScope(scope: TelegramMessageScope):
  | {
      kind: "custom";
      installationId: string;
      botId: string;
    }
  | {
      kind: "official";
      orgId: string;
      botId: string;
    } {
  if (typeof scope === "string") {
    return { kind: "custom", installationId: scope, botId: scope };
  }
  if (scope.kind === "custom") {
    return {
      kind: "custom",
      installationId: scope.installationId,
      botId: scope.installationId,
    };
  }
  return {
    kind: "official",
    orgId: scope.orgId,
    botId: OFFICIAL_TELEGRAM_BOT_ID,
  };
}

/**
 * Fetch recent Telegram messages for a chat and build execution context.
 *
 * @param installationId - Telegram installation ID
 * @param chatId - Telegram chat ID
 * @param lastProcessedMessageId - Only include messages after this ID for execution context
 * @param client - Telegram client (needed to download images for execution context)
 * @param currentMessageId - The message being processed; excluded from context to avoid duplication with prompt
 * @returns executionContext (only new messages, with file references)
 */
export async function fetchTelegramContext(
  scope: TelegramMessageScope,
  chatId: string,
  lastProcessedMessageId?: string,
  _client?: TelegramClient,
  currentMessageId?: string,
): Promise<{ executionContext: string }> {
  const normalizedScope = normalizeTelegramContextScope(scope);
  const messages = await globalThis.services.db
    .select({
      fromUsername: telegramMessages.fromUsername,
      fromDisplayName: telegramMessages.fromDisplayName,
      fromUserId: telegramMessages.fromUserId,
      text: telegramMessages.text,
      fileId: telegramMessages.fileId,
      fileType: telegramMessages.fileType,
      fileName: telegramMessages.fileName,
      fileMimeType: telegramMessages.fileMimeType,
      fileSize: telegramMessages.fileSize,
      fileWidth: telegramMessages.fileWidth,
      fileHeight: telegramMessages.fileHeight,
      fileDuration: telegramMessages.fileDuration,
      entities: telegramMessages.entities,
      isBot: telegramMessages.isBot,
      messageId: telegramMessages.messageId,
    })
    .from(telegramMessages)
    .where(
      and(
        normalizedScope.kind === "custom"
          ? eq(telegramMessages.installationId, normalizedScope.installationId)
          : eq(telegramMessages.officialOrgId, normalizedScope.orgId),
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

  // Execution context: include image references for on-demand CLI download.
  const executionContext =
    executionMessages.length > 0
      ? formatContextForAgent(executionMessages, normalizedScope.botId)
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
 * - SENDER: {id: 123, username: @alice} | {id: BOT}
 *
 * message text
 */
function formatMessageWithMetadata(
  msg: TelegramContextMessage,
  relativeIndex: number,
  fileParts?: string[],
): string {
  const senderParts = msg.isBot ? ["id: BOT"] : [`id: ${msg.fromUserId}`];
  if (!msg.isBot && msg.fromUsername) {
    senderParts.push(`username: @${msg.fromUsername}`);
  }
  if (!msg.isBot && msg.fromDisplayName) {
    senderParts.push(`name: ${msg.fromDisplayName}`);
  }
  const entitySummary = formatTelegramEntitiesForContext(
    msg.text ?? "",
    msg.entities,
  );

  const parts: string[] = [
    "---",
    "",
    `- RELATIVE_INDEX: ${relativeIndex}`,
    `- MSG_ID: ${msg.messageId}`,
    `- SENDER: {${senderParts.join(", ")}}`,
    ...(entitySummary ? [`- ENTITIES: ${entitySummary}`] : []),
    "",
    msg.text ?? "",
  ];

  if (fileParts && fileParts.length > 0) {
    parts.push(...fileParts);
  }

  return parts.join("\n");
}

function fileContextFromMessage(
  msg: TelegramContextMessage,
): TelegramFileContext | undefined {
  if (!msg.fileId) return undefined;

  return {
    file_id: msg.fileId,
    file_type:
      msg.fileType === "document" ||
      msg.fileType === "video" ||
      msg.fileType === "audio" ||
      msg.fileType === "voice" ||
      msg.fileType === "animation" ||
      msg.fileType === "video_note" ||
      msg.fileType === "sticker"
        ? msg.fileType
        : "photo",
    file_name: msg.fileName ?? undefined,
    mime_type: msg.fileMimeType ?? undefined,
    file_size: msg.fileSize ?? undefined,
    width: msg.fileWidth ?? undefined,
    height: msg.fileHeight ?? undefined,
    duration: msg.fileDuration ?? undefined,
  };
}

/**
 * Format message array with on-demand Telegram file references.
 */
function formatContextForAgent(
  messages: TelegramContextMessage[],
  botId: string,
): string {
  if (messages.length === 0) {
    return "";
  }

  const totalMessages = messages.length;

  const formattedMessages = messages
    .filter((m) => {
      return m.text || m.fileId || (m.entities && m.entities.length > 0);
    })
    .map((msg, index) => {
      const relativeIndex = index - totalMessages;
      const fileContext = fileContextFromMessage(msg);
      const fileParts = fileContext
        ? [formatTelegramFileForContext(fileContext, { botId })]
        : [];

      return formatMessageWithMetadata(msg, relativeIndex, fileParts);
    });

  const result = `# Telegram Chat Context\n\n${CONTEXT_PREAMBLE}\n\n${formattedMessages.join("\n\n")}\n\n---`;
  log.debug("Formatted messages for context with file references", {
    messageCount: formattedMessages.length,
    resultLength: result.length,
  });
  return result;
}
