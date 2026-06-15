import { command } from "ccstate";
import { testTelegramDispatchProbeContract } from "@vm0/api-contracts/contracts/test-telegram-dispatch-probe";

import { now } from "../external/time";
import { request$ } from "../context/hono";
import type { RouteEntry } from "../route";
import { safeJsonParse, settle } from "../utils";
import {
  dispatchTelegramDirectMessage$,
  dispatchTelegramMention$,
  type TelegramDispatchMessage,
} from "../services/zero-telegram-dispatch.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

interface ProbeBody {
  readonly bot_id: string;
  readonly chat_id: string;
  readonly telegram_user_id: string;
  readonly message_text: string;
  readonly message_id?: number;
  readonly chat_type?: "private" | "group" | "supergroup";
  readonly bot_username?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalChatType(
  value: unknown,
): "private" | "group" | "supergroup" | undefined {
  return value === "private" || value === "group" || value === "supergroup"
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseProbeBody(value: unknown): ProbeBody | null {
  if (!isRecord(value)) {
    return null;
  }
  const botId = optionalString(value.bot_id);
  const chatId = optionalString(value.chat_id);
  const telegramUserId = optionalString(value.telegram_user_id);
  const messageText = optionalString(value.message_text);
  if (!botId || !chatId || !telegramUserId || !messageText) {
    return null;
  }
  return {
    bot_id: botId,
    chat_id: chatId,
    telegram_user_id: telegramUserId,
    message_text: messageText,
    message_id: optionalNumber(value.message_id),
    chat_type: optionalChatType(value.chat_type),
    bot_username: optionalString(value.bot_username),
  };
}

function buildMessage(body: ProbeBody): TelegramDispatchMessage {
  const text = body.message_text;
  const chatType = body.chat_type ?? "private";
  const message: TelegramDispatchMessage = {
    message_id: body.message_id ?? Math.floor(now() % 1_000_000_000),
    from: {
      id: Number(body.telegram_user_id),
      is_bot: false,
      first_name: "E2E",
      username: "e2e-user",
    },
    chat: {
      id: Number(body.chat_id),
      type: chatType,
    },
    text,
  };

  const mentionOffset = body.bot_username
    ? text.indexOf(`@${body.bot_username}`)
    : -1;
  if (chatType !== "private" && body.bot_username && mentionOffset >= 0) {
    return {
      ...message,
      entities: [
        {
          type: "mention",
          offset: mentionOffset,
          length: body.bot_username.length + 1,
        },
      ],
    };
  }
  return message;
}

function handlerErrorBody(error: unknown): {
  readonly ok: false;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly stack?: string;
  };
} {
  const known = error instanceof Error ? error : new Error(String(error));
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  return {
    ok: false,
    error: {
      name: known.name,
      message: known.message,
      code,
      stack: known.stack?.split("\n").slice(0, 10).join("\n"),
    },
  };
}

const postTestTelegramDispatchProbe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const rawBody = await request.raw.clone().text();
    signal.throwIfAborted();
    const parsed = rawBody.length === 0 ? null : safeJsonParse(rawBody);
    const body = parseProbeBody(parsed);
    if (!body) {
      return {
        status: 400 as const,
        body: {
          error:
            "bot_id, chat_id, telegram_user_id, and message_text are required",
        },
      };
    }

    const message = buildMessage(body);
    const apiStartTime = now();
    const dispatch = settle(
      (async () => {
        if (message.chat.type === "private") {
          await set(
            dispatchTelegramDirectMessage$,
            { update: { message }, installationId: body.bot_id, apiStartTime },
            signal,
          );
        } else {
          await set(
            dispatchTelegramMention$,
            { update: { message }, installationId: body.bot_id, apiStartTime },
            signal,
          );
        }
      })(),
    );
    const result = await dispatch;
    signal.throwIfAborted();
    if (!result.ok) {
      return { status: 200 as const, body: handlerErrorBody(result.error) };
    }
    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testTelegramDispatchProbeRoutes: readonly RouteEntry[] = [
  {
    route: testTelegramDispatchProbeContract.post,
    handler: postTestTelegramDispatchProbe$,
  },
];
