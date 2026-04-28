import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { isTestEndpointAllowed } from "../../../../src/lib/auth/test-endpoint-guard";
import { handleTelegramDirectMessage } from "../../../../src/lib/zero/telegram/handlers/direct-message";
import { handleTelegramMention } from "../../../../src/lib/zero/telegram/handlers/mention";
import type { TelegramHandlerUpdate } from "../../../../src/lib/zero/telegram/handlers/types";

interface ProbeBody {
  bot_id: string;
  chat_id: string;
  telegram_user_id: string;
  message_text: string;
  message_id?: number;
  chat_type?: "private" | "group" | "supergroup";
  bot_username?: string;
}

function buildMessage(body: ProbeBody): TelegramHandlerUpdate["message"] {
  const text = body.message_text;
  const chatType = body.chat_type ?? "private";
  const message: TelegramHandlerUpdate["message"] = {
    message_id: body.message_id ?? Math.floor(Date.now() % 1000000000),
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
    message.entities = [
      {
        type: "mention",
        offset: mentionOffset,
        length: body.bot_username.length + 1,
      },
    ];
  }

  return message;
}

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const body = (await request.json().catch(() => {
    return null;
  })) as ProbeBody | null;

  if (
    !body?.bot_id ||
    !body.chat_id ||
    !body.telegram_user_id ||
    !body.message_text
  ) {
    return NextResponse.json(
      {
        error:
          "bot_id, chat_id, telegram_user_id, and message_text are required",
      },
      { status: 400 },
    );
  }

  initServices();
  const apiStartTime = Date.now();
  try {
    const message = buildMessage(body);
    if (message.chat.type === "private") {
      await handleTelegramDirectMessage({ message }, body.bot_id, apiStartTime);
    } else {
      await handleTelegramMention({ message }, body.bot_id, apiStartTime);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = err as Error & { stack?: string; code?: string };
    return NextResponse.json({
      ok: false,
      error: {
        name: e.name,
        message: e.message,
        code: e.code,
        stack: e.stack?.split("\n").slice(0, 10).join("\n"),
      },
    });
  }
}
