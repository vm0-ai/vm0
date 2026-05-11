import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsTelegramBotListContract } from "@vm0/api-contracts/contracts/integrations";
import { desc, eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import {
  buildOfficialTelegramBot,
  buildTelegramBot,
} from "../../../../integrations/telegram/telegram-status";

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

const router = tsr.router(integrationsTelegramBotListContract, {
  listBots: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "telegram:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    if (!authCtx.orgId) {
      return {
        status: 401 as const,
        body: errorBody("Not authenticated", "UNAUTHORIZED"),
      };
    }

    const installations = await globalThis.services.db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.orgId, authCtx.orgId))
      .orderBy(
        desc(telegramInstallations.createdAt),
        desc(telegramInstallations.telegramBotId),
      );

    const customBots = await Promise.all(
      installations.map((installation) => {
        return buildTelegramBot(installation, authCtx.userId);
      }),
    );
    const bots = [
      await buildOfficialTelegramBot({
        orgId: authCtx.orgId,
        userId: authCtx.userId,
      }),
      ...customBots,
    ];

    return { status: 200 as const, body: { bots } };
  },
});

const handler = createHandler(integrationsTelegramBotListContract, router, {
  routeName: "zero.integrations.telegram.bots",
});

export { handler as GET };
