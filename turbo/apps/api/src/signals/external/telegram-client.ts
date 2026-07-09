import { optionalEnv } from "../../lib/env";
import { createNativeAbortSignalWithTimeout, safeJsonParse } from "../utils";

const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const TELEGRAM_API_TIMEOUT_MS = 15_000;

interface TelegramApiErrorPayload {
  readonly ok: false;
  readonly description: string;
  readonly error_code?: number;
}

function isTelegramApiErrorPayload(
  value: unknown,
): value is TelegramApiErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as TelegramApiErrorPayload).ok === false
  );
}

interface TelegramApiErrorShape {
  readonly status: number;
  readonly description: string | undefined;
}

interface TelegramRequestOptions {
  readonly signal?: AbortSignal;
}

class TelegramApiError extends Error implements TelegramApiErrorShape {
  readonly status: number;
  readonly description: string | undefined;

  constructor(status: number, statusText: string, description?: string) {
    super(
      description
        ? `Telegram API error: ${status} ${description}`
        : `Telegram API error: ${status} ${statusText}`,
    );
    this.name = "TelegramApiError";
    this.status = status;
    this.description = description;
  }
}

export function isTelegramApiError(
  value: unknown,
): value is Error & TelegramApiErrorShape {
  return value instanceof TelegramApiError;
}

function isE2eTelegramMockEnabled(): boolean {
  const flag = optionalEnv("E2E_TELEGRAM_MOCK_ENABLED");
  return flag === "1" || flag === "true";
}

function resolveTelegramApiBase(): string {
  const telegramApiUrl = optionalEnv("TELEGRAM_API_URL");
  if (telegramApiUrl) {
    return telegramApiUrl;
  }

  if (!isE2eTelegramMockEnabled()) {
    return DEFAULT_TELEGRAM_API_BASE;
  }

  const vercelUrl = optionalEnv("VERCEL_URL");
  if (!vercelUrl) {
    throw new Error(
      "E2E_TELEGRAM_MOCK_ENABLED=1 but VERCEL_URL is unset; cannot redirect Telegram Bot API traffic to the preview mock routes",
    );
  }

  return `https://${vercelUrl}/api/test/telegram-mock/bot`;
}

function buildTelegramApiUrl(token: string, method: string): string {
  return `${resolveTelegramApiBase()}${token}/${method}`;
}

function buildTelegramApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const bypass = optionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET");
  if (isE2eTelegramMockEnabled() && bypass) {
    headers["x-vercel-protection-bypass"] = bypass;
    headers["x-vm0-test-endpoint-bypass"] = bypass;
  }
  return headers;
}

function createTelegramRequestAbort(signal?: AbortSignal): {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
} {
  return createNativeAbortSignalWithTimeout({
    signal,
    timeoutMs: TELEGRAM_API_TIMEOUT_MS,
    timeoutMessage: `Telegram API request timed out after ${TELEGRAM_API_TIMEOUT_MS}ms`,
    description: "telegram api request timeout",
  });
}

async function readTelegramResponseData(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const text = await response.text();
  signal.throwIfAborted();
  const data = safeJsonParse(text);
  if (data === undefined && response.ok) {
    throw new Error("Telegram API returned invalid JSON");
  }
  return data;
}

function telegramErrorDescription(data: unknown): string | undefined {
  if (isTelegramApiErrorPayload(data)) {
    return data.description;
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "description" in data &&
    typeof (data as { readonly description: unknown }).description === "string"
  ) {
    return (data as { readonly description: string }).description;
  }
  return undefined;
}

async function fetchTelegramApiJson(args: {
  readonly token: string;
  readonly method: string;
  readonly params?: Record<string, string>;
  readonly body?: Record<string, unknown>;
  readonly forcePost?: boolean;
  readonly signal?: AbortSignal;
}): Promise<{ readonly response: Response; readonly data: unknown }> {
  const url = buildTelegramApiUrl(args.token, args.method);
  const abort = createTelegramRequestAbort(args.signal);
  return await (async () => {
    const usePost = args.forcePost === true || isE2eTelegramMockEnabled();
    const response = usePost
      ? await fetch(url, {
          method: "POST",
          headers: buildTelegramApiHeaders(),
          body: JSON.stringify(args.body ?? args.params ?? {}),
          signal: abort.signal,
        })
      : await fetch(
          `${url}${
            args.params ? `?${new URLSearchParams(args.params).toString()}` : ""
          }`,
          { headers: buildTelegramApiHeaders(), signal: abort.signal },
        );
    return {
      response,
      data: await readTelegramResponseData(response, abort.signal),
    };
  })().finally(abort.cleanup);
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  params?: Record<string, string>,
  options: TelegramRequestOptions = {},
): Promise<T> {
  const { response, data } = await fetchTelegramApiJson({
    token,
    method,
    params,
    signal: options.signal,
  });

  const errorPayload = isTelegramApiErrorPayload(data) ? data : null;

  if (!response.ok || errorPayload) {
    throw new TelegramApiError(
      response.status,
      response.statusText,
      errorPayload?.description,
    );
  }

  return data as T;
}

interface TelegramBotInfo {
  readonly id: number;
  readonly username: string;
  readonly first_name: string;
  readonly can_read_all_group_messages?: boolean;
}

export async function getMe(token: string): Promise<TelegramBotInfo> {
  const result = await callTelegramApi<{
    readonly ok: true;
    readonly result: TelegramBotInfo;
  }>(token, "getMe");
  return result.result;
}

interface TelegramFile {
  readonly file_id: string;
  readonly file_path?: string;
  readonly file_size?: number;
}

export async function getFile(
  token: string,
  fileId: string,
): Promise<TelegramFile> {
  const result = await callTelegramApi<{
    readonly ok: true;
    readonly result: TelegramFile;
  }>(token, "getFile", { file_id: fileId });
  return result.result;
}

export function buildFileDownloadUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

export async function deleteWebhook(
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const { response, data } = await fetchTelegramApiJson({
    token,
    method: "deleteWebhook",
    forcePost: true,
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }

  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

export async function setWebhook(
  token: string,
  url: string,
  secretToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const { response, data } = await fetchTelegramApiJson({
    token,
    method: "setWebhook",
    body: {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
    },
    forcePost: true,
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }

  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

export async function setMyCommands(
  token: string,
  commands: readonly {
    readonly command: string;
    readonly description: string;
  }[],
  signal?: AbortSignal,
): Promise<void> {
  const { response, data } = await fetchTelegramApiJson({
    token,
    method: "setMyCommands",
    body: { commands },
    forcePost: true,
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }

  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

export interface TelegramUserProfilePhoto {
  readonly file_id: string;
  readonly file_unique_id?: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

export async function getUserProfilePhotos(
  token: string,
  userId: string | number,
  limit: number,
): Promise<readonly (readonly TelegramUserProfilePhoto[])[]> {
  const result = await callTelegramApi<{
    readonly ok: true;
    readonly result: {
      readonly total_count: number;
      readonly photos: readonly (readonly TelegramUserProfilePhoto[])[];
    };
  }>(token, "getUserProfilePhotos", {
    user_id: String(userId),
    limit: String(limit),
  });
  return result.result.photos;
}

/**
 * Send a chat action (e.g. typing indicator) to a Telegram chat.
 *
 * Uses POST with a JSON body to match how the Telegram Bot API is invoked
 * for state-changing methods. Response failures throw — callers that want
 * best-effort behaviour wrap the call themselves.
 */
export async function sendChatAction(
  token: string,
  chatId: string,
  action: string,
  signal?: AbortSignal,
): Promise<void> {
  const { response, data } = await fetchTelegramApiJson({
    token,
    method: "sendChatAction",
    body: { chat_id: chatId, action },
    forcePost: true,
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }
  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

/**
 * Delete a Telegram message.
 *
 * Response failures throw; callers that want best-effort cleanup should use
 * settle around this function.
 */
export async function deleteMessage(
  token: string,
  chatId: string,
  messageId: number,
  signal?: AbortSignal,
): Promise<void> {
  const { response, data } = await fetchTelegramApiJson({
    token,
    method: "deleteMessage",
    body: { chat_id: chatId, message_id: messageId },
    forcePost: true,
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }
  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

export type SendTelegramMessageResult =
  | {
      readonly kind: "ok";
      readonly messageId: number;
      readonly chatId: string;
    }
  | {
      readonly kind: "telegram-error";
      readonly status: number;
      readonly description: string | undefined;
    };

export interface TelegramReplyMarkup {
  readonly inline_keyboard: readonly (readonly {
    readonly text: string;
    readonly url: string;
  }[])[];
}

interface TelegramSentMessage {
  readonly message_id: number;
  readonly chat: { readonly id: number };
}

/**
 * Send a Telegram message using the bot API and surface upstream HTTP status
 * via a result-union. Callers map status >= 500 to 502 and status < 500 to 400
 * (Telegram client error). No exceptions are thrown for HTTP failures so
 * handlers can stay free of try/catch (per project policy).
 */
export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  options: {
    readonly replyToMessageId?: number;
    readonly messageThreadId?: number;
    readonly replyMarkup?: TelegramReplyMarkup;
    readonly signal?: AbortSignal;
  } = {},
): Promise<SendTelegramMessageResult> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (options.replyToMessageId !== undefined) {
    payload.reply_parameters = { message_id: options.replyToMessageId };
  }
  if (options.messageThreadId !== undefined) {
    payload.message_thread_id = options.messageThreadId;
  }
  if (options.replyMarkup !== undefined) {
    payload.reply_markup = options.replyMarkup;
  }

  const { response, data } = await fetchTelegramApiJson({
    token,
    method: "sendMessage",
    body: payload,
    forcePost: true,
    signal: options.signal,
  });

  if (!response.ok) {
    return {
      kind: "telegram-error",
      status: response.status,
      description: telegramErrorDescription(data),
    };
  }

  if (isTelegramApiErrorPayload(data)) {
    return {
      kind: "telegram-error",
      status: response.status,
      description: data.description,
    };
  }

  const success = data as {
    readonly ok: true;
    readonly result: TelegramSentMessage;
  };
  return {
    kind: "ok",
    messageId: success.result.message_id,
    chatId: String(success.result.chat.id),
  };
}

export interface TelegramDocument {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

interface TelegramSentDocumentMessage {
  readonly message_id: number;
  readonly chat: { readonly id: number };
  readonly document?: TelegramDocument;
}

export type SendTelegramDocumentResult =
  | {
      readonly kind: "ok";
      readonly messageId: number;
      readonly chatId: string;
      readonly document: TelegramDocument | undefined;
    }
  | {
      readonly kind: "telegram-error";
      readonly status: number;
      readonly description: string | undefined;
    };

/**
 * Send a Telegram document using the bot API and surface upstream HTTP status
 * via a result-union. Callers map status >= 500 to 502 and status < 500 to 400
 * (Telegram client error). No exceptions are thrown for HTTP failures so
 * handlers can stay free of try/catch (per project policy).
 */
export async function sendDocument(
  token: string,
  chatId: string,
  document: string,
  options: {
    readonly caption?: string;
    readonly messageThreadId?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<SendTelegramDocumentResult> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    document,
  };
  if (options.caption !== undefined) {
    payload.caption = options.caption;
  }
  if (options.messageThreadId !== undefined) {
    payload.message_thread_id = options.messageThreadId;
  }

  const { response, data } = await fetchTelegramApiJson({
    token,
    method: "sendDocument",
    body: payload,
    forcePost: true,
    signal: options.signal,
  });

  if (!response.ok) {
    return {
      kind: "telegram-error",
      status: response.status,
      description: telegramErrorDescription(data),
    };
  }

  if (isTelegramApiErrorPayload(data)) {
    return {
      kind: "telegram-error",
      status: response.status,
      description: data.description,
    };
  }

  const success = data as {
    readonly ok: true;
    readonly result: TelegramSentDocumentMessage;
  };
  return {
    kind: "ok",
    messageId: success.result.message_id,
    chatId: String(success.result.chat.id),
    document: success.result.document,
  };
}
