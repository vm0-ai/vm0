import { eq, and } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { decryptSecretValue } from "../../../shared/crypto/secrets-encryption";
import { env } from "../../../../env";
import { createTelegramClient, sendMessage } from "../client";
import { resolveUserLink, getWorkspaceAgent, buildConnectUrl } from "./shared";
import { escapeHtml } from "../format";
import { logger } from "../../../shared/logger";
import type { TelegramHandlerUpdate } from "./types";

const log = logger("telegram:new-session");

/**
 * Handle /new_session command
 *
 * Clears the DM session mapping so the next message creates a fresh agent session.
 * Only works in private chats (DMs).
 */
export async function handleNewSessionCommand(
  update: TelegramHandlerUpdate,
  installationId: string,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const message = update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);

  // Only works in DMs
  if (message.chat.type !== "private") {
    return;
  }

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

  // Delete the DM session mapping
  await globalThis.services.db
    .delete(telegramThreadSessions)
    .where(
      and(
        eq(telegramThreadSessions.telegramUserLinkId, userLink.id),
        eq(telegramThreadSessions.chatId, chatId),
        eq(telegramThreadSessions.rootMessageId, "dm"),
      ),
    );

  const agent = await getWorkspaceAgent(installation.defaultComposeId);
  const agentName = agent?.name ?? "Agent";

  await sendMessage(
    client,
    chatId,
    `New session started. 🤖 ${escapeHtml(agentName)} is ready.`,
  );

  log.info("DM session reset", { chatId, installationId });
}
