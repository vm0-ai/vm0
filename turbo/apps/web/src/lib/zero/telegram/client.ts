import { logger } from "../../shared/logger";
import { env } from "../../../env";
import { normalizeTelegramHtmlText } from "./format";

const log = logger("telegram:client");

const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const MAX_RETRIES = 3;

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

interface TelegramApiError extends Error {
  name: "TelegramApiError";
  method: string;
  status: number;
  description: string | undefined;
}

function makeTelegramApiError(
  method: string,
  status: number,
  description: string | undefined,
): TelegramApiError {
  return Object.assign(
    new Error(
      `Telegram API error (${method}): ${description ?? `HTTP ${status}`}`,
    ),
    {
      name: "TelegramApiError" as const,
      method,
      status,
      description,
    },
  );
}

export function isTelegramApiError(error: unknown): error is TelegramApiError {
  return (
    error instanceof Error &&
    error.name === "TelegramApiError" &&
    "method" in error &&
    "status" in error
  );
}

interface TelegramSentMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramSentDocumentMessage extends TelegramSentMessage {
  document?: TelegramDocument;
  caption?: string;
}

export interface TelegramClient {
  token: string;
}

interface TelegramInlineKeyboardButton {
  text: string;
  url: string;
}

interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

interface TelegramSendMessageOptions {
  replyToMessageId?: number;
  messageThreadId?: number;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

function isE2eTelegramMockEnabled(): boolean {
  const flag = env().E2E_TELEGRAM_MOCK_ENABLED;
  return flag === "1" || flag === "true";
}

function resolveTelegramApiBase(): string {
  const e = env();
  if (e.TELEGRAM_API_URL) return e.TELEGRAM_API_URL;

  if (!isE2eTelegramMockEnabled()) return DEFAULT_TELEGRAM_API_BASE;
  if (!e.VERCEL_URL) {
    throw new Error(
      "E2E_TELEGRAM_MOCK_ENABLED=1 but VERCEL_URL is unset; cannot redirect Telegram Bot API traffic to the preview mock routes",
    );
  }
  return `https://${e.VERCEL_URL}/api/test/telegram-mock/bot`;
}

function buildTelegramApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (isE2eTelegramMockEnabled()) {
    const bypass = env().VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) {
      headers["x-vercel-protection-bypass"] = bypass;
    }
  }
  return headers;
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
  const url = `${resolveTelegramApiBase()}${token}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: buildTelegramApiHeaders(),
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
      await new Promise((resolve) => {
        return setTimeout(resolve, retryAfter * 1000);
      });
      return callTelegramApi<T>(token, method, params, _retryCount + 1);
    }

    throw makeTelegramApiError(method, response.status, data.description);
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
  options?: TelegramSendMessageOptions,
): Promise<TelegramSentMessage> {
  return callTelegramApi<TelegramSentMessage>(client.token, "sendMessage", {
    chat_id: chatId,
    text: normalizeTelegramHtmlText(text),
    parse_mode: "HTML",
    ...(options?.replyToMessageId && {
      reply_parameters: { message_id: options.replyToMessageId },
    }),
    ...(options?.messageThreadId && {
      message_thread_id: options.messageThreadId,
    }),
    ...(options?.replyMarkup && { reply_markup: options.replyMarkup }),
  });
}

/**
 * Send a general file by Telegram file id or HTTP URL.
 */
export async function sendDocument(
  client: TelegramClient,
  chatId: string | number,
  document: string,
  options?: { caption?: string; messageThreadId?: number },
): Promise<TelegramSentDocumentMessage> {
  return callTelegramApi<TelegramSentDocumentMessage>(
    client.token,
    "sendDocument",
    {
      chat_id: chatId,
      document,
      ...(options?.caption ? { caption: options.caption } : {}),
      ...(options?.messageThreadId
        ? { message_thread_id: options.messageThreadId }
        : {}),
    },
  );
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
 * Edit a text message
 */
export async function editMessageText(
  client: TelegramClient,
  chatId: string | number,
  messageId: number,
  text: string,
): Promise<TelegramSentMessage> {
  return callTelegramApi<TelegramSentMessage>(client.token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: normalizeTelegramHtmlText(text),
    parse_mode: "HTML",
  });
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

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramUserProfilePhoto {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramUserProfilePhotos {
  total_count: number;
  photos: TelegramUserProfilePhoto[][];
}

/**
 * Get file info and download path from Telegram.
 * The returned file_path can be used to download via:
 * https://api.telegram.org/file/bot<token>/<file_path>
 */
export async function getFile(
  client: TelegramClient,
  fileId: string,
): Promise<TelegramFile> {
  return callTelegramApi<TelegramFile>(client.token, "getFile", {
    file_id: fileId,
  });
}

/**
 * Get profile photos for a Telegram user or bot.
 */
export async function getUserProfilePhotos(
  client: TelegramClient,
  userId: string | number,
  limit = 1,
): Promise<TelegramUserProfilePhotos> {
  return callTelegramApi<TelegramUserProfilePhotos>(
    client.token,
    "getUserProfilePhotos",
    {
      user_id: userId,
      limit,
    },
  );
}

/**
 * Build a download URL for a Telegram file.
 */
export function buildFileDownloadUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
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
