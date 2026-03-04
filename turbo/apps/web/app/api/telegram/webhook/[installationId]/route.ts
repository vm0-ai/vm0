import { after } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { telegramInstallations } from "../../../../../src/db/schema/telegram-installation";
import { verifyTelegramWebhook } from "../../../../../src/lib/telegram/verify";
import { handleTelegramMention } from "../../../../../src/lib/telegram/handlers/mention";
import { handleTelegramDirectMessage } from "../../../../../src/lib/telegram/handlers/direct-message";
import { handleStartCommand } from "../../../../../src/lib/telegram/handlers/start";
import { storeTelegramMessage } from "../../../../../src/lib/telegram/handlers/shared";
import { logger } from "../../../../../src/lib/logger";

const log = logger("telegram:webhook");

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; is_bot?: boolean };
    text?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
    reply_to_message?: {
      message_id: number;
      from?: { id: number; is_bot?: boolean };
    };
  };
}

/**
 * Telegram Webhook Endpoint
 *
 * POST /api/telegram/webhook/[installationId]
 *
 * Routing:
 * - /start command → handleStartCommand
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
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
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
