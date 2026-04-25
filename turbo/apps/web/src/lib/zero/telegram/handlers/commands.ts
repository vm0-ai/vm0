import { eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { decryptSecretValue } from "../../../shared/crypto/secrets-encryption";
import { env } from "../../../../env";
import { createTelegramClient, sendMessage } from "../client";
import { resolveUserLink, getWorkspaceAgent, buildConnectUrl } from "./shared";
import { escapeHtml } from "../format";
import { logger } from "../../../shared/logger";
import type { TelegramHandlerUpdate } from "./types";

const log = logger("telegram:commands");

/**
 * Handle /connect command
 *
 * If user is already linked, confirms the connection.
 * If not, directs them to the platform to connect their account.
 */
export async function handleConnectCommand(
  update: TelegramHandlerUpdate,
  installationId: string,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const message = update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);

  const [installation] = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installationId))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);

  const userLink = await resolveUserLink(installationId, fromUserId);

  const replyOptions =
    message.chat.type !== "private"
      ? { replyToMessageId: message.message_id }
      : undefined;

  if (userLink) {
    const agent = await getWorkspaceAgent(installation.defaultComposeId);
    const agentName = agent?.name ?? "Agent";
    await sendMessage(
      client,
      chatId,
      `You are already connected. 🤖 ${escapeHtml(agentName)} is ready.`,
      replyOptions,
    );
    return;
  }

  // In group chats, don't expose the connect URL publicly to prevent
  // other users from hijacking the link. Direct users to DM instead.
  if (message.chat.type !== "private") {
    await sendMessage(
      client,
      chatId,
      `🔗 Please <a href="https://t.me/${escapeHtml(installation.botUsername ?? "")}?start=connect">send me /connect</a> in a private message to connect your account.`,
      replyOptions,
    );
    return;
  }

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
}

/**
 * Handle /disconnect command
 *
 * Removes the user link and disconnects the Telegram integration.
 */
export async function handleDisconnectCommand(
  update: TelegramHandlerUpdate,
  installationId: string,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const message = update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);

  const [installation] = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installationId))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);

  const userLink = await resolveUserLink(installationId, fromUserId);

  const replyOptions =
    message.chat.type !== "private"
      ? { replyToMessageId: message.message_id }
      : undefined;

  if (!userLink) {
    await sendMessage(client, chatId, "You are not connected.", replyOptions);
    return;
  }

  // Delete user link
  await globalThis.services.db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.id, userLink.id));

  await sendMessage(
    client,
    chatId,
    "You have been disconnected and your agent access has been revoked.",
    replyOptions,
  );

  log.info("User disconnected", {
    chatId,
    installationId,
    telegramUserId: fromUserId,
  });
}

/**
 * Handle /help command
 *
 * Lists available commands and usage info.
 */
export async function handleHelpCommand(
  update: TelegramHandlerUpdate,
  installationId: string,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const message = update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);

  const [installation] = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installationId))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);

  const userLink = await resolveUserLink(installationId, fromUserId);
  const isAdmin = userLink?.vm0UserId === installation.ownerUserId;
  const botUsername = installation.botUsername ?? "bot";

  const replyOptions =
    message.chat.type !== "private"
      ? { replyToMessageId: message.message_id }
      : undefined;

  let helpText = `<b>Available commands:</b>\n\n`;
  helpText += `/new_session - Start a new conversation\n`;
  helpText += `/connect - Connect your VM0 account\n`;
  helpText += `/disconnect - Disconnect your account\n`;
  helpText += `/help - Show this help message\n`;
  helpText += `\nMention @${escapeHtml(botUsername)} in a group or send a DM to chat with the agent.`;

  if (isAdmin) {
    helpText += `\n\nYou are the admin of this bot installation.`;
  }

  await sendMessage(client, chatId, helpText, replyOptions);
}
