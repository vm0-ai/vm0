import { NextResponse } from "next/server";
import { isTestEndpointAllowed } from "../../../../../../src/lib/auth/test-endpoint-guard";
import { TELEGRAM_E2E_FIXTURES } from "../../../../../../src/lib/test-endpoints/telegram-mock-fixtures";
import { logTelegramMockCall } from "../../../../../../src/lib/test-endpoints/telegram-mock-logger";

function ok<T>(result: T): NextResponse {
  return NextResponse.json({ ok: true, result });
}

function stripBotPrefix(token: string): string {
  return token.startsWith("bot") ? token.slice(3) : token;
}

function readChatId(body: Record<string, unknown> | null): number {
  const raw = body?.chat_id;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number(TELEGRAM_E2E_FIXTURES.chatId);
}

async function parseJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  return (await request
    .clone()
    .json()
    .catch(() => {
      return null;
    })) as Record<string, unknown> | null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ botToken: string; method: string }> },
) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { botToken: rawBotToken, method } = await params;
  const botToken = stripBotPrefix(rawBotToken);
  await logTelegramMockCall(method, botToken, request);
  const body = await parseJson(request);
  const chatId = readChatId(body);

  switch (method) {
    case "getMe":
      return ok({
        id: Number(TELEGRAM_E2E_FIXTURES.botId),
        is_bot: true,
        first_name: "VM0 E2E",
        username: TELEGRAM_E2E_FIXTURES.botUsername,
      });
    case "sendMessage":
    case "editMessageText":
      return ok({
        message_id: Math.floor(Date.now() % 1000000000),
        chat: { id: chatId },
        text: typeof body?.text === "string" ? body.text : undefined,
      });
    case "sendChatAction":
    case "deleteMessage":
    case "deleteWebhook":
    case "setWebhook":
    case "setMyCommands":
      return ok(true);
    case "getFile":
      return ok({
        file_id: String(body?.file_id ?? "e2e-file"),
        file_unique_id: "e2e-file-unique",
        file_path: "photos/e2e-file.jpg",
      });
    default:
      return NextResponse.json(
        { ok: false, description: `Unsupported mock method: ${method}` },
        { status: 404 },
      );
  }
}
