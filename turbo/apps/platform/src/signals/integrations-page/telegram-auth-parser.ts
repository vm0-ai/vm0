import { throwIfAbort } from "../utils.ts";

export interface TelegramAuthResult {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

function extractAuth(d: Record<string, unknown>): TelegramAuthResult | null {
  if (!d.id || !d.auth_date || !d.hash) {
    return null;
  }
  return {
    id: Number(d.id),
    first_name: (d.first_name as string) ?? undefined,
    last_name: (d.last_name as string) ?? undefined,
    username: (d.username as string) ?? undefined,
    photo_url: (d.photo_url as string) ?? undefined,
    auth_date: Number(d.auth_date),
    hash: d.hash as string,
  };
}

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch (error) {
    throwIfAbort(error);
    return undefined;
  }
}

export function parseTelegramPostMessage(
  data: unknown,
): TelegramAuthResult | null {
  // Telegram may double-encode the JSON string
  let raw: unknown = data;
  while (typeof raw === "string") {
    const parsed = tryParseJson(raw);
    if (parsed === undefined) {
      return null;
    }
    raw = parsed;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  // Our callback route sends { type: "telegram-auth", data: {...} }
  if (obj.type === "telegram-auth" && obj.data) {
    return extractAuth(obj.data as Record<string, unknown>);
  }

  // Telegram sends { event: "auth_result", result: {...} }
  if (obj.event === "auth_result" && obj.result) {
    return extractAuth(obj.result as Record<string, unknown>);
  }

  return null;
}
