import { eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { decryptSecretValue } from "../../../shared/crypto/secrets-encryption";
import { env } from "../../../../env";
import { createTelegramClient, sendMessage, deleteMessage } from "../client";
import {
  sendThinkingMessage,
  sendQueuedNotification,
  enrichTelegramPrompt,
  formatReplyQuote,
  appendPhotoContext,
  lookupTelegramThreadSession,
  storeTelegramMessage,
  getWorkspaceAgent,
  getAgentDisplayLabel,
  resolveSessionCompose,
  resolveUserLink,
  resolveTelegramAuditLogsUrl,
  formatTelegramPrivateConnectPrompt,
} from "./shared";
import { fetchTelegramContext } from "../context";
import { runAgentForTelegram } from "./run-agent";
import { buildTelegramErrorResponse } from "../format";
import { logger } from "../../../shared/logger";
import type { TelegramHandlerUpdate } from "./types";

const log = logger("telegram:mention");

/**
 * Handle a group @mention of the bot
 *
 * Flow:
 * 1. Look up installation → decrypt bot token → create client
 * 2. Check user link → if not linked, send login prompt
 * 3. Resolve workspace agent
 * 4. Send typing indicator
 * 5. Store incoming message
 * 6. Strip @botusername from message text
 * 7. Determine thread anchor (reply-to-bot or new)
 * 8. Look up existing session
 * 9. Fetch context
 * 10. Dispatch agent run
 */
export async function handleTelegramMention(
  update: TelegramHandlerUpdate,
  installationId: string,
  apiStartTime: number,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const message = update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);

  // 1. Get installation
  const [installation] = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installationId))
    .limit(1);

  if (!installation) {
    log.error("Installation not found", { installationId });
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);

  // 2. Check user link (auto-completes pending link if needed)
  const userLink = await resolveUserLink(installationId, fromUserId);

  if (!userLink) {
    await sendMessage(
      client,
      chatId,
      formatTelegramPrivateConnectPrompt(installation.botUsername),
      { replyToMessageId: message.message_id },
    );
    return;
  }

  // 3. Resolve workspace agent
  const composeId = installation.defaultComposeId;
  const defaultAgent = await getWorkspaceAgent(composeId);
  if (!defaultAgent) {
    await sendMessage(
      client,
      chatId,
      "The agent is not available. Please contact the admin.",
      { replyToMessageId: message.message_id },
    );
    return;
  }
  const agentName = getAgentDisplayLabel(defaultAgent);

  // 4. Send thinking placeholder message (reply to user's message in groups)
  const thinkingMessage = await sendThinkingMessage(client, chatId, agentName, {
    replyToMessageId: message.message_id,
  });

  // 5. Store incoming message
  await storeTelegramMessage(installationId, chatId, message);

  // 6. Strip @botusername from message text (entities for text, caption_entities for photos)
  const messageText = stripBotMention(
    message.text ?? message.caption ?? "",
    installation.botUsername,
    message.entities ?? message.caption_entities,
  );

  // 6b. Enrich prompt with user info and current message's photo
  const { prompt: messageContent, userInfoExtras } = enrichTelegramPrompt(
    messageText,
    message.from,
  );
  let enrichedPrompt = appendPhotoContext(
    messageContent,
    message,
    installation.telegramBotId,
  );

  // 6c. Prepend reply context if this message is a reply to another message
  const replyQuote = formatReplyQuote(message.reply_to_message);
  if (replyQuote) {
    enrichedPrompt = `${replyQuote}\n\n${enrichedPrompt}`;
  }

  // 7. Determine thread anchor and resolve session
  const { rootMessageId, existingSessionId, lastProcessedMessageId } =
    await resolveThreadSession(
      message,
      chatId,
      userLink.id,
      userLink.vm0UserId,
      composeId,
    );

  // 9. Fetch context (exclude current message to avoid duplication with prompt)
  const { executionContext } = await fetchTelegramContext(
    installationId,
    chatId,
    lastProcessedMessageId,
    client,
    String(message.message_id),
  );
  const { status, response, runId } = await runAgentForTelegram({
    composeId,
    agentId: defaultAgent.agentId,
    agentName,
    sessionId: existingSessionId,
    prompt: enrichedPrompt,
    threadContext: executionContext,
    userInfoExtras,
    botId: installation.telegramBotId,
    botUsername: installation.botUsername,
    chatId,
    chatType: message.chat.type,
    messageId: String(message.message_id),
    rootMessageId: rootMessageId ?? null,
    messageThreadId: message.message_thread_id,
    userId: userLink.vm0UserId,
    apiStartTime,
    callbackContext: {
      installationId,
      chatId,
      messageId: String(message.message_id),
      rootMessageId: rootMessageId ?? null,
      userLinkId: userLink.id,
      agentId: composeId,
      existingSessionId: existingSessionId ?? null,
      isDM: false,
      thinkingMessageId: thinkingMessage
        ? String(thinkingMessage.message_id)
        : null,
    },
  });

  if (status === "queued") {
    await sendQueuedNotification(client, chatId, thinkingMessage, {
      replyToMessageId: message.message_id,
    });
  } else if (status === "failed") {
    log.error("Failed to dispatch agent run (mention)", {
      chatId,
      agentName,
      composeId,
      runId,
      response,
    });
    if (thinkingMessage) {
      await deleteMessage(client, chatId, thinkingMessage.message_id);
    }
    const errorDetail =
      response ?? "An unexpected error occurred. Please try again later.";
    const linkUrl = await resolveTelegramAuditLogsUrl({
      orgId: installation.orgId,
      userId: userLink.vm0UserId,
      runId,
    });
    await sendMessage(
      client,
      chatId,
      buildTelegramErrorResponse(errorDetail, linkUrl),
      { replyToMessageId: message.message_id },
    );
  }
}

async function resolveThreadSession(
  message: TelegramHandlerUpdate["message"],
  chatId: string,
  userLinkId: string,
  vm0UserId: string,
  composeId: string,
): Promise<{
  rootMessageId: string | undefined;
  existingSessionId: string | undefined;
  lastProcessedMessageId: string | undefined;
}> {
  let rootMessageId: string | undefined;
  if (
    message.reply_to_message?.from?.is_bot &&
    message.reply_to_message.message_id
  ) {
    rootMessageId = String(message.reply_to_message.message_id);
  }

  let existingSessionId: string | undefined;
  let lastProcessedMessageId: string | undefined;
  if (rootMessageId) {
    const session = await lookupTelegramThreadSession(
      chatId,
      rootMessageId,
      userLinkId,
    );
    existingSessionId = session.existingSessionId;
    lastProcessedMessageId = session.lastProcessedMessageId;
  }

  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      vm0UserId,
    );
    if (sessionCompose && sessionCompose.composeId !== composeId) {
      log.debug("Agent changed, starting new session", {
        sessionComposeId: sessionCompose.composeId,
        currentComposeId: composeId,
      });
      existingSessionId = undefined;
      lastProcessedMessageId = undefined;
    }
  }

  return { rootMessageId, existingSessionId, lastProcessedMessageId };
}

/**
 * Strip @botusername from message text
 */
function stripBotMention(
  text: string,
  botUsername: string | null,
  entities?: Array<{ type: string; offset: number; length: number }>,
): string {
  if (!botUsername || !entities) return text;

  // Find mention entities and remove them
  const mentionText = `@${botUsername}`;
  return text
    .replace(new RegExp(`\\s*${escapeRegExp(mentionText)}\\s*`, "gi"), " ")
    .trim();
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
