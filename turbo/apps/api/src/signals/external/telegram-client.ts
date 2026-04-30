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
  readonly file_path: string;
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
