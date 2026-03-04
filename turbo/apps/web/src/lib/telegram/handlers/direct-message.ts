import { eq, and } from "drizzle-orm";
import { telegramInstallations } from "../../../db/schema/telegram-installation";
import { telegramUserLinks } from "../../../db/schema/telegram-user-link";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import { createTelegramClient, sendMessage, sendChatAction } from "../client";
import { fetchTelegramContext } from "../context";
import { runAgentForTelegram } from "./run-agent";
import {
  lookupTelegramThreadSession,
  storeTelegramMessage,
  getWorkspaceAgent,
  resolveSessionCompose,
} from "./shared";
import { logger } from "../../logger";

const log = logger("telegram:dm");

interface TelegramUpdate {
  message: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; is_bot?: boolean };
    text?: string;
  };
}

/**
 * Handle a direct message to the bot
 *
 * Same flow as mention handler except:
 * - No mention stripping
 * - Use rootMessageId = "dm" sentinel for single ongoing DM session
 */
export async function handleTelegramDirectMessage(
  update: TelegramUpdate,
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

  // 2. Check user link
  const [userLink] = await globalThis.services.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.telegramUserId, fromUserId),
        eq(telegramUserLinks.installationId, installationId),
      ),
    )
    .limit(1);

  if (!userLink) {
    await sendMessage(
      client,
      chatId,
      "Please link your account first. Send /start to begin.",
    );
    return;
  }

  // 3. Resolve workspace agent
  let composeId = installation.defaultComposeId;
  const defaultAgent = await getWorkspaceAgent(composeId);
  if (!defaultAgent) {
    await sendMessage(
      client,
      chatId,
      "The agent is not available. Please contact the admin.",
    );
    return;
  }
  let agentName = defaultAgent.name;

  // 4. Send typing indicator
  await sendChatAction(client, chatId, "typing");

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
  const existingSessionId = session.existingSessionId;
  const lastProcessedMessageId = session.lastProcessedMessageId;

  // 7b. If continuing session, use session's compose
  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      userLink.vm0UserId,
    );
    if (sessionCompose) {
      composeId = sessionCompose.composeId;
      agentName = sessionCompose.agentName;
    }
  }

  // 8. Fetch context
  const { executionContext } = await fetchTelegramContext(
    installationId,
    chatId,
    lastProcessedMessageId,
  );

  // 9. Dispatch agent run
  const { status, response } = await runAgentForTelegram({
    composeId,
    agentName,
    sessionId: existingSessionId,
    prompt: message.text ?? "",
    threadContext: executionContext,
    userId: userLink.vm0UserId,
    callbackContext: {
      installationId,
      chatId,
      messageId: String(message.message_id),
      userLinkId: userLink.id,
      agentName,
      composeId,
      existingSessionId: existingSessionId ?? null,
    },
  });

  if (status === "failed") {
    log.error("Failed to dispatch agent run", { response });
    await sendMessage(
      client,
      chatId,
      response ?? "Sorry, an error occurred. Please try again.",
    );
  }
}
