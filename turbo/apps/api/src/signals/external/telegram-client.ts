interface TelegramApiError {
  readonly ok: false;
  readonly description: string;
}

function isTelegramApiError(value: unknown): value is TelegramApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as TelegramApiError).ok === false
  );
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const searchParams = params
    ? `?${new URLSearchParams(params).toString()}`
    : "";

  const response = await fetch(`${url}${searchParams}`);

  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }

  const data: unknown = await response.json();

  if (isTelegramApiError(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }

  return data as T;
}

interface TelegramBotInfo {
  readonly id: number;
  readonly username: string;
  readonly first_name: string;
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

export async function deleteWebhook(token: string): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/deleteWebhook`,
    { method: "POST" },
  );

  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }

  const data: unknown = await response.json();
  if (isTelegramApiError(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
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
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendChatAction`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }
  const data: unknown = await response.json();
  if (isTelegramApiError(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

type SendTelegramMessageResult =
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
  } = {},
): Promise<SendTelegramMessageResult> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
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

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data: unknown = await response.json();

  if (!response.ok) {
    const description =
      data && typeof data === "object" && "description" in data
        ? typeof (data as { description: unknown }).description === "string"
          ? ((data as { description: string }).description as string)
          : undefined
        : undefined;
    return {
      kind: "telegram-error",
      status: response.status,
      description,
    };
  }

  if (isTelegramApiError(data)) {
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
  } = {},
): Promise<SendTelegramDocumentResult> {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
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

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data: unknown = await response.json();

  if (!response.ok) {
    const description =
      data && typeof data === "object" && "description" in data
        ? typeof (data as { description: unknown }).description === "string"
          ? ((data as { description: string }).description as string)
          : undefined
        : undefined;
    return {
      kind: "telegram-error",
      status: response.status,
      description,
    };
  }

  if (isTelegramApiError(data)) {
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
