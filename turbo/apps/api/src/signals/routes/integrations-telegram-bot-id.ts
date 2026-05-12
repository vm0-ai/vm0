import { command } from "ccstate";
import { eq } from "drizzle-orm";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishOrgSignal } from "../external/realtime";
import { deleteWebhook } from "../external/telegram-client";
import { decryptSecretValue } from "../services/crypto.utils";
import { logger } from "../../lib/log";
import { safeAsync } from "../utils";
import type { RouteEntry } from "../route";

const log = logger("api:telegram:integration-bot");

function notFoundResponse() {
  return {
    status: 404 as const,
    body: {
      error: { message: "Telegram bot not found", code: "NOT_FOUND" as const },
    },
  };
}

function forbiddenResponse(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

const disconnectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { botId } = get(
    pathParamsOf(zeroIntegrationsTelegramContract.disconnect),
  );

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    return forbiddenResponse("The official Telegram bot cannot be uninstalled");
  }

  const writeDb = set(writeDb$);
  const [installation] = await writeDb
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, botId))
    .limit(1);
  signal.throwIfAborted();

  if (!installation || installation.orgId !== auth.orgId) {
    return notFoundResponse();
  }

  if (installation.ownerUserId !== auth.userId && auth.orgRole !== "admin") {
    return forbiddenResponse(
      "Only the bot owner or an org admin can uninstall this bot",
    );
  }

  const botToken = decryptSecretValue(installation.encryptedBotToken);
  const webhookResult = await safeAsync(() => {
    return deleteWebhook(botToken);
  });
  signal.throwIfAborted();
  if ("error" in webhookResult) {
    log.warn("Failed to remove Telegram webhook", {
      error: webhookResult.error,
    });
  }

  await writeDb
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installation.telegramBotId));
  signal.throwIfAborted();

  const publishResult = await safeAsync(() => {
    return publishOrgSignal(installation.orgId, "telegram:changed");
  });
  signal.throwIfAborted();
  if ("error" in publishResult) {
    log.warn("Failed to publish Telegram org change", {
      error: publishResult.error,
    });
  }

  return { status: 204 as const, body: undefined };
});

export const integrationsTelegramBotIdRoutes: readonly RouteEntry[] = [
  {
    route: zeroIntegrationsTelegramContract.disconnect,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      disconnectInner$,
    ),
  },
];
