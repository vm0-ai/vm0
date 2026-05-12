import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { logger } from "../../lib/log";
import { safeAsync } from "../utils";
import type { RouteEntry } from "../route";

const log = logger("api:telegram:link");

function noLinkedTelegramAccountResponse() {
  return {
    status: 404 as const,
    body: {
      error: {
        message: "No linked Telegram account",
        code: "NOT_FOUND" as const,
      },
    },
  };
}

async function publishTelegramUserChanged(userId: string): Promise<void> {
  const publishResult = await safeAsync(() => {
    return publishUserSignal([userId], "telegram:changed");
  });
  if ("error" in publishResult) {
    log.warn("Failed to publish Telegram user change", {
      error: publishResult.error,
    });
  }
}

const unlinkInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { botId } = get(queryOf(zeroIntegrationsTelegramContract.unlink));
  const writeDb = set(writeDb$);

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    const deleted = await writeDb
      .delete(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.vm0UserId, auth.userId),
          eq(telegramOfficialUserLinks.orgId, auth.orgId),
        ),
      )
      .returning({ id: telegramOfficialUserLinks.id });
    signal.throwIfAborted();

    if (deleted.length === 0) {
      return noLinkedTelegramAccountResponse();
    }

    await publishTelegramUserChanged(auth.userId);
    signal.throwIfAborted();
    return { status: 204 as const, body: undefined };
  }

  const orgInstallations = writeDb
    .select({ telegramBotId: telegramInstallations.telegramBotId })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, auth.orgId));

  const deleted = await writeDb
    .delete(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.vm0UserId, auth.userId),
        inArray(telegramUserLinks.installationId, orgInstallations),
        botId ? eq(telegramUserLinks.installationId, botId) : undefined,
      ),
    )
    .returning({ id: telegramUserLinks.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return noLinkedTelegramAccountResponse();
  }

  await publishTelegramUserChanged(auth.userId);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const integrationsTelegramLinkRoutes: readonly RouteEntry[] = [
  {
    route: zeroIntegrationsTelegramContract.unlink,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      unlinkInner$,
    ),
  },
];
