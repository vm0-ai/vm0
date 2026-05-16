import { command } from "ccstate";
import { testTelegramMockContract } from "@vm0/api-contracts/contracts/test-telegram-mock";
import { TELEGRAM_E2E_FIXTURES } from "@vm0/core/telegram-e2e-fixtures";
import { e2eTelegramMockCallLog } from "@vm0/db/schema/e2e-telegram-mock-call-log";

import { now } from "../../lib/time";
import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route";
import { safeJsonParse, settle } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(result: unknown): Response {
  return jsonResponse({ ok: true, result });
}

function stripBotPrefix(token: string): string {
  return token.startsWith("bot") ? token.slice(3) : token;
}

function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  if (rawBody.length === 0) {
    return null;
  }

  const parsed = safeJsonParse(rawBody);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function readChatId(body: Record<string, unknown> | null): number {
  const raw = body?.chat_id;
  if (typeof raw === "number") {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number(TELEGRAM_E2E_FIXTURES.chatId);
}

function readLogChatId(body: Record<string, unknown> | null): string | null {
  const raw = body?.chat_id;
  if (typeof raw === "number" || typeof raw === "string") {
    return String(raw);
  }
  return null;
}

async function logTelegramMockCall({
  db,
  method,
  botToken,
  rawBody,
  bodyJson,
}: {
  readonly db: Db;
  readonly method: string;
  readonly botToken: string;
  readonly rawBody: string;
  readonly bodyJson: Record<string, unknown> | null;
}): Promise<void> {
  await settle(
    db.insert(e2eTelegramMockCallLog).values({
      method,
      botToken,
      chatId: readLogChatId(bodyJson),
      body: rawBody,
      bodyJson,
    }),
  );
}

const postTestTelegramMock$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const { botToken: rawBotToken, method } = get(
      pathParamsOf(testTelegramMockContract.post),
    );
    const botToken = stripBotPrefix(rawBotToken);
    const rawBody = await request.raw.clone().text();
    signal.throwIfAborted();

    const body = parseJsonObject(rawBody);
    await logTelegramMockCall({
      db: set(writeDb$),
      method,
      botToken,
      rawBody,
      bodyJson: body,
    });
    signal.throwIfAborted();

    const chatId = readChatId(body);

    switch (method) {
      case "getMe": {
        return ok({
          id: Number(TELEGRAM_E2E_FIXTURES.botId),
          is_bot: true,
          first_name: "VM0 E2E",
          username: TELEGRAM_E2E_FIXTURES.botUsername,
        });
      }
      case "sendMessage":
      case "editMessageText": {
        return ok({
          message_id: Math.floor(now() % 1_000_000_000),
          chat: { id: chatId },
          text: typeof body?.text === "string" ? body.text : undefined,
        });
      }
      case "sendChatAction":
      case "deleteMessage":
      case "deleteWebhook":
      case "setWebhook":
      case "setMyCommands": {
        return ok(true);
      }
      case "getFile": {
        return ok({
          file_id: String(body?.file_id ?? "e2e-file"),
          file_unique_id: "e2e-file-unique",
          file_path: "photos/e2e-file.jpg",
        });
      }
      default: {
        return jsonResponse(
          { ok: false, description: `Unsupported mock method: ${method}` },
          404,
        );
      }
    }
  },
);

export const testTelegramMockRoutes: readonly RouteEntry[] = [
  {
    route: testTelegramMockContract.post,
    handler: postTestTelegramMock$,
  },
];
