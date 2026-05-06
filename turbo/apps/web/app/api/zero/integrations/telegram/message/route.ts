import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsTelegramMessageContract } from "@vm0/api-contracts/contracts/integrations";
import { and, eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { decryptSecretValue } from "../../../../../../src/lib/shared/crypto/secrets-encryption";
import {
  createTelegramClient,
  isTelegramApiError,
  sendMessage,
} from "../../../../../../src/lib/zero/telegram/client";
import { buildTelegramResponse } from "../../../../../../src/lib/zero/telegram/format";
import { resolveTelegramMessageSendFooterText } from "../../../../../../src/lib/zero/telegram/footer";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../../../../../../src/lib/zero/telegram/official";
import type {
  SendTelegramMessageBody,
  SendTelegramMessageResponse,
} from "@vm0/api-contracts/contracts/integrations";

type RouteErrorStatus = 400 | 403 | 404 | 502;

type RouteErrorResponse<TStatus extends RouteErrorStatus = RouteErrorStatus> = {
  status: TStatus;
  body: ReturnType<typeof errorBody>;
};

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function routeError<TStatus extends RouteErrorStatus>(
  status: TStatus,
  message: string,
  code: string,
): RouteErrorResponse<TStatus> {
  return {
    status,
    body: errorBody(message, code),
  };
}

function isRouteErrorResponse(result: unknown): result is RouteErrorResponse {
  return Boolean(result && typeof result === "object" && "status" in result);
}

async function resolveTelegramBotToken(
  orgId: string,
  botId: string,
): Promise<string | null> {
  if (isOfficialTelegramBotId(botId)) {
    return getOfficialTelegramBotConfig().botToken;
  }

  const [row] = await globalThis.services.db
    .select({ encryptedBotToken: telegramInstallations.encryptedBotToken })
    .from(telegramInstallations)
    .where(
      and(
        eq(telegramInstallations.telegramBotId, botId),
        eq(telegramInstallations.orgId, orgId),
      ),
    )
    .limit(1);

  if (!row) return null;

  return decryptSecretValue(
    row.encryptedBotToken,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );
}

async function sendTelegramTextMessage(params: {
  body: SendTelegramMessageBody;
  botToken: string;
  footerText: string | undefined;
}): Promise<SendTelegramMessageResponse | RouteErrorResponse<400 | 502>> {
  const { body, botToken, footerText } = params;
  const client = createTelegramClient(botToken);
  const text = buildTelegramResponse(body.text, undefined, footerText);

  try {
    const sentMessage = await sendMessage(client, body.chatId, text, {
      replyToMessageId: body.replyToMessageId,
      messageThreadId: body.messageThreadId,
    });

    return {
      ok: true,
      messageId: sentMessage.message_id,
      chatId: String(sentMessage.chat.id),
    };
  } catch (error) {
    if (isTelegramApiError(error)) {
      const message = `Telegram API error: ${error.description ?? `HTTP ${error.status}`}`;
      return routeError(
        error.status >= 500 ? 502 : 400,
        message,
        "TELEGRAM_ERROR",
      );
    }
    throw error;
  }
}

const router = tsr.router(integrationsTelegramMessageContract, {
  sendMessage: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "telegram:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    if (!authCtx.orgId) {
      return {
        status: 403 as const,
        body: errorBody("Organization context is required", "FORBIDDEN"),
      };
    }

    const botToken = await resolveTelegramBotToken(authCtx.orgId, body.botId);
    if (!botToken) {
      return routeError(404, "Telegram bot not found", "NOT_FOUND");
    }

    const footerText = await resolveTelegramMessageSendFooterText({
      authRunId: authCtx.runId,
      botId: body.botId,
    });

    const result = await sendTelegramTextMessage({
      body,
      botToken,
      footerText,
    });
    if (isRouteErrorResponse(result)) return result;

    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(integrationsTelegramMessageContract, router, {
  routeName: "zero.integrations.telegram.message",
});

export { handler as POST };
