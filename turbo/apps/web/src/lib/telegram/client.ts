import { logger } from "../logger";

const log = logger("telegram:client");

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const MAX_RETRIES = 3;

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export interface TelegramSentMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

export interface TelegramClient {
  token: string;
}

/**
 * Create a Telegram Bot API client
 */
export function createTelegramClient(token: string): TelegramClient {
  return { token };
}

/**
 * Call the Telegram Bot API
 *
 * @param token - Bot token
 * @param method - API method name
 * @param params - Method parameters
 * @returns API response result
 */
export async function callTelegramApi<T>(
  token: string,
  method: string,
  params?: Record<string, unknown>,
  _retryCount = 0,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}${token}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params ? JSON.stringify(params) : undefined,
  });

  const data = (await response.json()) as TelegramApiResponse<T>;

  if (!response.ok || !data.ok) {
    if (
      response.status === 429 &&
      data.parameters?.retry_after &&
      _retryCount < MAX_RETRIES
    ) {
      const retryAfter = data.parameters.retry_after;
      log.warn("Rate limited by Telegram, retrying", {
        method,
        retryAfter,
        attempt: _retryCount + 1,
      });
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return callTelegramApi<T>(token, method, params, _retryCount + 1);
    }

    throw new Error(
      `Telegram API error (${method}): ${data.description ?? `HTTP ${response.status}`}`,
    );
  }

  return data.result;
}

/**
 * Send a text message
 */
export async function sendMessage(
  client: TelegramClient,
  chatId: string | number,
  text: string,
  options?: { replyToMessageId?: number },
): Promise<TelegramSentMessage> {
  return callTelegramApi<TelegramSentMessage>(client.token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(options?.replyToMessageId && {
      reply_parameters: { message_id: options.replyToMessageId },
    }),
  });
}

/**
 * Send a chat action (e.g. typing indicator)
 */
export async function sendChatAction(
  client: TelegramClient,
  chatId: string | number,
  action: string,
): Promise<void> {
  await callTelegramApi<boolean>(client.token, "sendChatAction", {
    chat_id: chatId,
    action,
  });
}

/**
 * Verify bot token and get bot info
 */
export async function getMe(token: string): Promise<TelegramBotInfo> {
  return callTelegramApi<TelegramBotInfo>(token, "getMe");
}

/**
 * Register a webhook URL with Telegram
 */
export async function setWebhook(
  token: string,
  url: string,
  secretToken: string,
): Promise<void> {
  await callTelegramApi<boolean>(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
  });
}

/**
 * Remove webhook
 */
export async function deleteWebhook(token: string): Promise<void> {
  await callTelegramApi<boolean>(token, "deleteWebhook");
}

/**
 * Delete a message
 */
export async function deleteMessage(
  client: TelegramClient,
  chatId: string | number,
  messageId: number,
): Promise<void> {
  await callTelegramApi<boolean>(client.token, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

/**
 * Register bot commands
 */
export async function setMyCommands(
  token: string,
  commands: Array<{ command: string; description: string }>,
): Promise<void> {
  await callTelegramApi<boolean>(token, "setMyCommands", { commands });
}
