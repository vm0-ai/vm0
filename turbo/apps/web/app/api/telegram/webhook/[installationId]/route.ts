import { after } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { telegramInstallations } from "../../../../../src/db/schema/telegram-installation";
import { verifyTelegramWebhook } from "../../../../../src/lib/telegram/verify";
import { handleTelegramMention } from "../../../../../src/lib/telegram/handlers/mention";
import { handleTelegramDirectMessage } from "../../../../../src/lib/telegram/handlers/direct-message";
import { handleStartCommand } from "../../../../../src/lib/telegram/handlers/start";
import { handleNewSessionCommand } from "../../../../../src/lib/telegram/handlers/new-session";
import {
  handleConnectCommand,
  handleDisconnectCommand,
  handleSettingsCommand,
  handleHelpCommand,
} from "../../../../../src/lib/telegram/handlers/commands";
import { storeTelegramMessage } from "../../../../../src/lib/telegram/handlers/shared";
import { logger } from "../../../../../src/lib/logger";
import type { TelegramHandlerUpdate } from "../../../../../src/lib/telegram/handlers/types";

const log = logger("telegram:webhook");

interface TelegramWebhookUpdate {
  update_id: number;
  message?: TelegramHandlerUpdate["message"];
}

/**
 * Telegram Webhook Endpoint
 *
 * POST /api/telegram/webhook/[installationId]
 *
 * Routing:
 * - /start command → handleStartCommand
 * - /new_session command → handleNewSessionCommand
 * - /connect command → handleConnectCommand
 * - /disconnect command → handleDisconnectCommand
 * - /settings command → handleSettingsCommand
 * - /help command → handleHelpCommand
 * - Private chat (DM) → handleTelegramDirectMessage
 * - Bot @mention in group → handleTelegramMention
 * - Reply to bot message → handleTelegramMention (continuation)
 * - Other messages → store silently for context
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ installationId: string }> },
) {
  const { installationId } = await params;

  initServices();

  // Look up installation for webhook secret
  const [installation] = await globalThis.services.db
    .select({
      id: telegramInstallations.id,
      webhookSecret: telegramInstallations.webhookSecret,
      botUsername: telegramInstallations.botUsername,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.id, installationId))
    .limit(1);

  if (!installation) {
    return new Response("Not Found", { status: 404 });
  }

  // Verify webhook secret
  if (!verifyTelegramWebhook(request, installation.webhookSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse update
  let update: TelegramWebhookUpdate;
  try {
    update = (await request.json()) as TelegramWebhookUpdate;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const message = update.message;
  if (!message || !message.text) {
    // No text message — nothing to process
    return new Response("OK", { status: 200 });
  }

  const chatId = String(message.chat.id);

  // Route to appropriate handler
  after(
    (async () => {
      // /start command
      if (message.text?.startsWith("/start")) {
        await handleStartCommand({ message }, installationId);
        return;
      }

      // /new_session command
      if (message.text?.startsWith("/new_session")) {
        await handleNewSessionCommand({ message }, installationId);
        return;
      }

      // /connect command
      if (message.text?.startsWith("/connect")) {
        await handleConnectCommand({ message }, installationId);
        return;
      }

      // /disconnect command
      if (message.text?.startsWith("/disconnect")) {
        await handleDisconnectCommand({ message }, installationId);
        return;
      }

      // /settings command
      if (message.text?.startsWith("/settings")) {
        await handleSettingsCommand({ message }, installationId);
        return;
      }

      // /help command
      if (message.text?.startsWith("/help")) {
        await handleHelpCommand({ message }, installationId);
        return;
      }

      // Private chat (DM)
      if (message.chat.type === "private") {
        await handleTelegramDirectMessage({ message }, installationId);
        return;
      }

      // Check for bot @mention in entities
      const hasBotMention =
        installation.botUsername &&
        message.entities?.some(
          (e) =>
            e.type === "mention" &&
            message.text?.slice(e.offset, e.offset + e.length).toLowerCase() ===
              `@${installation.botUsername?.toLowerCase()}`,
        );

      // Check if reply to bot's message
      const isReplyToBot = message.reply_to_message?.from?.is_bot === true;

      if (hasBotMention || isReplyToBot) {
        await handleTelegramMention({ message }, installationId);
        return;
      }

      // Non-matching message — store silently for context
      await storeTelegramMessage(installationId, chatId, message);
    })().catch((error) => {
      log.error("Error handling telegram webhook", { error, installationId });
    }),
  );

  // Return 200 immediately
  return new Response("OK", { status: 200 });
}
