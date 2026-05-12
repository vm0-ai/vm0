import { eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { decryptSecretValue } from "../../../shared/crypto/secrets-encryption";
import { env } from "../../../../env";
import { createTelegramClient, sendMessage } from "../client";
import {
  sendTypingAction,
  sendQueuedNotification,
  enrichTelegramPrompt,
  formatReplyQuote,
  appendTelegramMessageContext,
  lookupTelegramThreadSession,
  storeTelegramMessage,
  getWorkspaceAgent,
  getAgentDisplayLabel,
  resolveSessionCompose,
  resolveUserLink,
  buildConnectUrl,
  resolveTelegramAuditLogsUrl,
  buildTelegramConnectReplyMarkup,
  formatTelegramConnectPrompt,
  formatTelegramUserDisplayName,
  getWorkspaceAgentDisplayLabel,
} from "./shared";
import { fetchTelegramContext } from "../context";
import { runAgentForTelegram } from "./run-agent";
import { buildTelegramErrorResponse } from "../format";
import { canReuseSessionForRunModel } from "../../context/session-model-compatibility";
import { logger } from "../../../shared/logger";
import type { TelegramHandlerUpdate } from "./types";

const log = logger("telegram:dm");

/**
 * Handle a direct message to the bot
 *
 * Same flow as mention handler except:
 * - No mention stripping
 * - Use rootMessageId = "dm" sentinel for single ongoing DM session
 */
export async function handleTelegramDirectMessage(
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
  const telegramDisplayName = formatTelegramUserDisplayName(message.from);

  // 2. Check user link (auto-completes pending link if needed)
  const userLink = await resolveUserLink(
    installationId,
    fromUserId,
    message.from?.username ?? null,
    telegramDisplayName,
  );

  if (!userLink) {
    const agentName = await getWorkspaceAgentDisplayLabel(
      installation.defaultComposeId,
    );
    const connectUrl = buildConnectUrl(
      installation.telegramBotId,
      fromUserId,
      botToken,
      message.from?.username ?? null,
      telegramDisplayName,
    );
    await sendMessage(client, chatId, formatTelegramConnectPrompt(agentName), {
      replyMarkup: buildTelegramConnectReplyMarkup(connectUrl),
    });
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
    );
    return;
  }
  const agentName = getAgentDisplayLabel(defaultAgent);

  // 4. Send typing indicator
  await sendTypingAction(client, chatId);

  // 5. Store incoming message
  await storeTelegramMessage(installationId, chatId, message);

  // 6. Use "dm" sentinel as rootMessageId for single ongoing DM session
  const rootMessageId = "dm";

  // 7. Look up an existing DM session when it is compatible with this run.
  const { existingSessionId, lastProcessedMessageId } =
    await resolveDirectMessageSession({
      chatId,
      rootMessageId,
      userLinkId: userLink.id,
      userId: userLink.vm0UserId,
      orgId: installation.orgId,
      composeId,
    });

  // 8. Fetch new conversation context; existing sessions already have older history.
  const { executionContext } = await fetchTelegramContext(
    installationId,
    chatId,
    lastProcessedMessageId,
    client,
    String(message.message_id),
  );

  // 9. Enrich prompt with user info and current message's photo
  const { prompt: messageContent, userInfoExtras } = enrichTelegramPrompt(
    message.text ?? message.caption ?? "",
    message.from,
  );
  let enrichedPrompt = appendTelegramMessageContext(
    messageContent,
    message,
    installation.telegramBotId,
  );

  // 9b. Prepend reply context if this message is a reply to another message
  const replyQuote = formatReplyQuote(message.reply_to_message);
  if (replyQuote) {
    enrichedPrompt = `${replyQuote}\n\n${enrichedPrompt}`;
  }

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
    rootMessageId,
    messageThreadId: message.message_thread_id,
    userId: userLink.vm0UserId,
    apiStartTime,
    callbackContext: {
      installationId,
      chatId,
      messageId: String(message.message_id),
      rootMessageId: "dm",
      userLinkId: userLink.id,
      agentId: composeId,
      existingSessionId: existingSessionId ?? null,
      isDM: true,
    },
  });

  if (status === "queued") {
    await sendQueuedNotification(client, chatId);
  } else if (status === "failed") {
    log.error("Failed to dispatch agent run (DM)", {
      chatId,
      agentName,
      composeId,
      runId,
      response,
    });
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
    );
  }
}

async function resolveDirectMessageSession(params: {
  chatId: string;
  rootMessageId: string;
  userLinkId: string;
  userId: string;
  orgId: string;
  composeId: string;
}): Promise<{
  existingSessionId: string | undefined;
  lastProcessedMessageId: string | undefined;
}> {
  const session = await lookupTelegramThreadSession(
    params.chatId,
    params.rootMessageId,
    params.userLinkId,
  );
  let existingSessionId = session.existingSessionId;
  let lastProcessedMessageId = session.lastProcessedMessageId;

  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      params.userId,
    );
    if (sessionCompose && sessionCompose.composeId !== params.composeId) {
      log.debug("Agent changed, starting new session", {
        sessionComposeId: sessionCompose.composeId,
        currentComposeId: params.composeId,
      });
      existingSessionId = undefined;
      lastProcessedMessageId = undefined;
    }
  }

  if (existingSessionId) {
    const canReuseSession = await canReuseSessionForRunModel({
      sessionId: existingSessionId,
      userId: params.userId,
      orgId: params.orgId,
      agentComposeId: params.composeId,
    });
    if (!canReuseSession) {
      log.debug("Model changed, starting new session", {
        composeId: params.composeId,
        existingSessionId,
      });
      existingSessionId = undefined;
      lastProcessedMessageId = undefined;
    }
  }

  return { existingSessionId, lastProcessedMessageId };
}
