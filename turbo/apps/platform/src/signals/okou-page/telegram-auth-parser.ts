import { jsonParseOr } from "../utils.ts";

export interface TelegramAuthResult {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractAuth(data: Record<string, unknown>): TelegramAuthResult | null {
  if (!data.id || !data.auth_date || typeof data.hash !== "string") {
    return null;
  }
  return {
    id: Number(data.id),
    first_name: optionalString(data.first_name),
    last_name: optionalString(data.last_name),
    username: optionalString(data.username),
    photo_url: optionalString(data.photo_url),
    auth_date: Number(data.auth_date),
    hash: data.hash,
  };
}

export function parseTelegramPostMessage(
  data: unknown,
): TelegramAuthResult | null {
  let raw = data;
  while (typeof raw === "string") {
    const parsed = jsonParseOr<unknown>(raw, undefined);
    if (parsed === undefined) {
      return null;
    }
    raw = parsed;
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const payload = raw as Record<string, unknown>;

  if (
    payload.type === "telegram-auth" &&
    typeof payload.data === "object" &&
    payload.data !== null
  ) {
    return extractAuth(payload.data as Record<string, unknown>);
  }

  if (
    payload.event === "auth_result" &&
    typeof payload.result === "object" &&
    payload.result !== null
  ) {
    return extractAuth(payload.result as Record<string, unknown>);
  }

  return null;
}
