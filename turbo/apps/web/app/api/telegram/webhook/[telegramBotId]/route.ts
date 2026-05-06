import { after } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { verifyTelegramWebhook } from "../../../../../src/lib/zero/telegram/verify";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../../../../../src/lib/zero/telegram/official";
import { resolveOfficialUserLink } from "../../../../../src/lib/zero/telegram/official-user";
import { handleTelegramMention } from "../../../../../src/lib/zero/telegram/handlers/mention";
import { handleTelegramDirectMessage } from "../../../../../src/lib/zero/telegram/handlers/direct-message";
import { handleStartCommand } from "../../../../../src/lib/zero/telegram/handlers/start";
import { handleNewSessionCommand } from "../../../../../src/lib/zero/telegram/handlers/new-session";
import {
  handleConnectCommand,
  handleDisconnectCommand,
  handleHelpCommand,
} from "../../../../../src/lib/zero/telegram/handlers/commands";
import {
  handleOfficialConnectCommand,
  handleOfficialDisconnectCommand,
  handleOfficialHelpCommand,
  handleOfficialNewSessionCommand,
  handleOfficialStartCommand,
  handleOfficialTelegramDirectMessage,
  handleOfficialTelegramMention,
} from "../../../../../src/lib/zero/telegram/handlers/official";
import {
  formatTelegramUserDisplayName,
  hasTelegramMessageContextContent,
  storeTelegramMessage,
} from "../../../../../src/lib/zero/telegram/handlers/shared";
import { logger } from "../../../../../src/lib/shared/logger";
import type { TelegramHandlerUpdate } from "../../../../../src/lib/zero/telegram/handlers/types";

const log = logger("telegram:webhook");

interface TelegramWebhookUpdate {
  update_id: number;
  message?: TelegramHandlerUpdate["message"];
}

/**
 * Telegram Webhook Endpoint
 *
 * POST /api/telegram/webhook/[telegramBotId]
 *
 * Routing:
 * - /start command → handleStartCommand
 * - /new_session command → handleNewSessionCommand
 * - /connect command → handleConnectCommand
 * - /disconnect command → handleDisconnectCommand
 * - /help command → handleHelpCommand
 * - Private chat (DM) → handleTelegramDirectMessage
 * - Bot @mention in group → handleTelegramMention
 * - Reply to bot message → handleTelegramMention (continuation)
 * - Other messages → store silently for context
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ telegramBotId: string }> },
) {
  const apiStartTime = Date.now();
  const { telegramBotId } = await params;

  initServices();

  if (isOfficialTelegramBotId(telegramBotId)) {
    return handleOfficialTelegramWebhook(request, apiStartTime);
  }

  // Look up installation for webhook secret
  const [installation] = await globalThis.services.db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      webhookSecret: telegramInstallations.webhookSecret,
      botUsername: telegramInstallations.botUsername,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, telegramBotId))
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
    const json: unknown = await request.json();
    update = json as TelegramWebhookUpdate;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const message = update.message;
  if (!message || !hasTelegramMessageContextContent(message)) {
    // No supported content — nothing to process
    return new Response("OK", { status: 200 });
  }

  const chatId = String(message.chat.id);

  // Route to appropriate handler
  after(() => {
    return (async () => {
      const messageText = message.text ?? message.caption;
      const command = parseBotCommand(messageText, installation.botUsername);

      if (command === "start") {
        await handleStartCommand({ message }, telegramBotId);
        return;
      }

      if (command === "new_session") {
        await handleNewSessionCommand({ message }, telegramBotId);
        return;
      }

      if (command === "connect") {
        await handleConnectCommand({ message }, telegramBotId);
        return;
      }

      if (command === "disconnect") {
        await handleDisconnectCommand({ message }, telegramBotId);
        return;
      }

      if (command === "help") {
        await handleHelpCommand({ message }, telegramBotId);
        return;
      }

      // Private chat (DM)
      if (message.chat.type === "private") {
        await handleTelegramDirectMessage(
          { message },
          telegramBotId,
          apiStartTime,
        );
        return;
      }

      // Check for bot @mention in entities or caption_entities
      const mentionSource = message.text ?? message.caption ?? "";
      const allEntities = [
        ...(message.entities ?? []),
        ...(message.caption_entities ?? []),
      ];
      const hasBotMention =
        installation.botUsername &&
        allEntities.some((e) => {
          return (
            e.type === "mention" &&
            mentionSource.slice(e.offset, e.offset + e.length).toLowerCase() ===
              `@${installation.botUsername?.toLowerCase()}`
          );
        });

      // Check if reply to bot's message
      const isReplyToBot = message.reply_to_message?.from?.is_bot === true;

      if (hasBotMention || isReplyToBot) {
        await handleTelegramMention({ message }, telegramBotId, apiStartTime);
        return;
      }

      // Non-matching message — store silently for context
      await storeTelegramMessage(telegramBotId, chatId, message);
    })().catch((error) => {
      log.error("Error handling telegram webhook", {
        error,
        telegramBotId,
      });
    });
  });

  // Return 200 immediately
  return new Response("OK", { status: 200 });
}

async function handleOfficialTelegramWebhook(
  request: Request,
  apiStartTime: number,
): Promise<Response> {
  const config = getOfficialTelegramBotConfig();
  if (!config.botToken || !config.webhookSecret) {
    return new Response("Not Found", { status: 404 });
  }

  if (!verifyTelegramWebhook(request, config.webhookSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TelegramWebhookUpdate;
  try {
    const json: unknown = await request.json();
    update = json as TelegramWebhookUpdate;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const message = update.message;
  if (!message || !hasTelegramMessageContextContent(message)) {
    return new Response("OK", { status: 200 });
  }

  const chatId = String(message.chat.id);

  after(() => {
    return processOfficialTelegramMessage({
      message,
      config,
      chatId,
      apiStartTime,
    }).catch((error) => {
      log.error("Error handling official telegram webhook", {
        error,
      });
    });
  });

  return new Response("OK", { status: 200 });
}

async function processOfficialTelegramMessage(params: {
  message: TelegramHandlerUpdate["message"];
  config: ReturnType<typeof getOfficialTelegramBotConfig>;
  chatId: string;
  apiStartTime: number;
}): Promise<void> {
  const messageText = params.message.text ?? params.message.caption;
  const command = parseBotCommand(messageText, params.config.botUsername);

  if (await dispatchOfficialTelegramCommand(command, params.message)) {
    return;
  }

  if (params.message.chat.type === "private") {
    await handleOfficialTelegramDirectMessage(
      { message: params.message },
      params.apiStartTime,
    );
    return;
  }

  if (isOfficialMentionOrReply(params.message, params.config.botUsername)) {
    await handleOfficialTelegramMention(
      { message: params.message },
      params.apiStartTime,
    );
    return;
  }

  await storeOfficialTelegramContextIfLinked(params.message, params.chatId);
}

async function dispatchOfficialTelegramCommand(
  command: string | undefined,
  message: TelegramHandlerUpdate["message"],
): Promise<boolean> {
  switch (command) {
    case "start":
      await handleOfficialStartCommand({ message });
      return true;
    case "new_session":
      await handleOfficialNewSessionCommand({ message });
      return true;
    case "connect":
      await handleOfficialConnectCommand({ message });
      return true;
    case "disconnect":
      await handleOfficialDisconnectCommand({ message });
      return true;
    case "help":
      await handleOfficialHelpCommand({ message });
      return true;
    default:
      return false;
  }
}

function isOfficialMentionOrReply(
  message: TelegramHandlerUpdate["message"],
  botUsername: string | null,
): boolean {
  const isReplyToBot = message.reply_to_message?.from?.is_bot === true;
  if (isReplyToBot) return true;
  if (!botUsername) return false;

  const mentionSource = message.text ?? message.caption ?? "";
  const allEntities = [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ];

  return allEntities.some((e) => {
    return (
      e.type === "mention" &&
      mentionSource.slice(e.offset, e.offset + e.length).toLowerCase() ===
        `@${botUsername.toLowerCase()}`
    );
  });
}

async function storeOfficialTelegramContextIfLinked(
  message: TelegramHandlerUpdate["message"],
  chatId: string,
): Promise<void> {
  const userLink = await resolveOfficialUserLink(
    String(message.from?.id ?? 0),
    message.from?.username ?? null,
    formatTelegramUserDisplayName(message.from),
  );
  if (!userLink) return;

  await storeTelegramMessage(
    { kind: "official", orgId: userLink.orgId, userLinkId: userLink.id },
    chatId,
    message,
  );
}

/**
 * Parse a bot command from message text, respecting @username targeting.
 *
 * In groups, Telegram commands can be targeted: `/connect@BotA`.
 * If the command targets a different bot, returns undefined so this
 * bot ignores it. In private chats, the @suffix is optional.
 *
 * Returns the command name (without slash or @suffix), or undefined.
 */
function parseBotCommand(
  text: string | undefined,
  botUsername: string | null,
): string | undefined {
  if (!text || !text.startsWith("/")) {
    return undefined;
  }

  // Extract command part (first word, e.g. "/connect@BotA")
  const firstWord = text.split(/\s/)[0];
  if (!firstWord) {
    return undefined;
  }

  const atIndex = firstWord.indexOf("@");
  if (atIndex === -1) {
    // No @suffix — command applies to all bots (or is in DM)
    return firstWord.slice(1).toLowerCase();
  }

  // Has @suffix — only respond if it matches this bot
  const targetUsername = firstWord.slice(atIndex + 1);
  if (
    botUsername &&
    targetUsername.toLowerCase() === botUsername.toLowerCase()
  ) {
    return firstWord.slice(1, atIndex).toLowerCase();
  }

  // Targeted at a different bot
  return undefined;
}
