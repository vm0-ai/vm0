import { eq } from "drizzle-orm";
import { telegramInstallations } from "../../../db/schema/telegram-installation";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import { createTelegramClient, sendMessage, deleteMessage } from "../client";
import { sendThinkingMessage } from "./shared";
import { fetchTelegramContext } from "../context";
import { runAgentForTelegram } from "./run-agent";
import {
  lookupTelegramThreadSession,
  storeTelegramMessage,
  getWorkspaceAgent,
  resolveSessionCompose,
  resolveUserLink,
  buildConnectUrl,
} from "./shared";
import { escapeHtml } from "../format";
import { logger } from "../../logger";
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
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const message = update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);

  // 1. Get installation
  const [installation] = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.id, installationId))
    .limit(1);

  if (!installation) {
    log.error("Installation not found", { installationId });
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);

  // 2. Check user link (auto-completes pending link if needed)
  const userLink = await resolveUserLink(installationId, fromUserId);

  if (!userLink) {
    const connectUrl = buildConnectUrl(
      installationId,
      installation.telegramBotId,
      fromUserId,
      botToken,
    );
    await sendMessage(
      client,
      chatId,
      `🔗 Connect your account to get started:\n\n<a href="${escapeHtml(connectUrl)}">Open Platform</a>`,
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
  const agentName = defaultAgent.name;

  // 4. Send thinking placeholder message (reply to user's message in groups)
  const thinkingMessage = await sendThinkingMessage(client, chatId, agentName, {
    replyToMessageId: message.message_id,
  });

  // 5. Store incoming message
  await storeTelegramMessage(installationId, chatId, message);

  // 6. Strip @botusername from message text
  const messageText = stripBotMention(
    message.text ?? "",
    installation.botUsername,
    message.entities,
  );

  // 7. Determine thread anchor and resolve session
  const { rootMessageId, existingSessionId, lastProcessedMessageId } =
    await resolveThreadSession(
      message,
      chatId,
      userLink.id,
      userLink.vm0UserId,
      composeId,
    );

  // 9. Fetch context
  const { executionContext } = await fetchTelegramContext(
    installationId,
    chatId,
    lastProcessedMessageId,
  );

  // 10. Dispatch agent run
  const { status, response } = await runAgentForTelegram({
    composeId,
    agentName,
    sessionId: existingSessionId,
    prompt: messageText,
    threadContext: executionContext,
    userId: userLink.vm0UserId,
    callbackContext: {
      installationId,
      chatId,
      messageId: String(message.message_id),
      rootMessageId: rootMessageId ?? null,
      userLinkId: userLink.id,
      agentName,
      composeId,
      existingSessionId: existingSessionId ?? null,
      isDM: false,
      thinkingMessageId: thinkingMessage
        ? String(thinkingMessage.message_id)
        : null,
    },
  });

  if (status === "failed") {
    log.error("Failed to dispatch agent run", { response });
    if (thinkingMessage) {
      await deleteMessage(client, chatId, thinkingMessage.message_id);
    }
    await sendMessage(
      client,
      chatId,
      response ?? "Sorry, an error occurred. Please try again.",
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
