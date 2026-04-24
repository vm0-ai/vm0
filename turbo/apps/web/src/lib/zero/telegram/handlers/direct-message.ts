import { eq } from "drizzle-orm";
import { telegramInstallations } from "../../../../db/schema/telegram-installation";
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
  resolveSessionCompose,
  resolveUserLink,
  buildConnectUrl,
  buildAgentLogsUrl,
  buildLogsUrl,
} from "./shared";
import { fetchTelegramContext } from "../context";
import { runAgentForTelegram } from "./run-agent";
import { buildTelegramErrorResponse, escapeHtml } from "../format";
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

  // 2. Check user link (auto-completes pending link if needed)
  const userLink = await resolveUserLink(installationId, fromUserId);

  if (!userLink) {
    const connectUrl = buildConnectUrl(
      installation.telegramBotId,
      fromUserId,
      botToken,
    );
    await sendMessage(
      client,
      chatId,
      `🔗 Connect your account to get started:\n\n<a href="${escapeHtml(connectUrl)}">Open Platform</a>`,
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
    );
    return;
  }
  const agentName = defaultAgent.name;

  // 4. Send thinking placeholder message
  const thinkingMessage = await sendThinkingMessage(client, chatId, agentName);

  // 5. Store incoming message
  await storeTelegramMessage(installationId, chatId, message);

  // 6. Use "dm" sentinel as rootMessageId for single ongoing DM session
  const rootMessageId = "dm";

  // 7. Look up existing session
  const session = await lookupTelegramThreadSession(
    chatId,
    rootMessageId,
    userLink.id,
  );
  let existingSessionId = session.existingSessionId;
  const lastProcessedMessageId = session.lastProcessedMessageId;

  // 7b. Validate session's agent matches current default — discard only on positive mismatch
  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      userLink.vm0UserId,
    );
    if (sessionCompose && sessionCompose.composeId !== composeId) {
      log.debug("Agent changed, starting new session", {
        sessionComposeId: sessionCompose.composeId,
        currentComposeId: composeId,
      });
      existingSessionId = undefined;
    }
  }

  // 8. Fetch context (skip when continuing an existing session — it already has history)
  let executionContext = "";
  if (!existingSessionId) {
    const ctx = await fetchTelegramContext(
      installationId,
      chatId,
      lastProcessedMessageId,
      client,
      String(message.message_id),
    );
    executionContext = ctx.executionContext;
  }

  // 9. Enrich prompt with user info and current message's photo
  let enrichedPrompt = enrichTelegramPrompt(
    message.text ?? message.caption ?? "",
    message.from,
  );
  enrichedPrompt = await appendPhotoContext(
    enrichedPrompt,
    message,
    client,
    installationId,
    chatId,
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
      thinkingMessageId: thinkingMessage
        ? String(thinkingMessage.message_id)
        : null,
    },
  });

  if (status === "queued") {
    await sendQueuedNotification(client, chatId, thinkingMessage);
  } else if (status === "failed") {
    log.error("Failed to dispatch agent run (DM)", {
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
    const linkUrl = runId ? buildLogsUrl(runId) : buildAgentLogsUrl();
    await sendMessage(
      client,
      chatId,
      buildTelegramErrorResponse(errorDetail, linkUrl),
    );
  }
}
