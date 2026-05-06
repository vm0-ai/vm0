import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsTelegramBotListContract } from "@vm0/api-contracts/contracts/integrations";
import { desc, eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { buildTelegramBot } from "../../../../integrations/telegram/telegram-status";

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
        status: 403 as const,
        body: errorBody("Organization context is required", "FORBIDDEN"),
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

    const bots = await Promise.all(
      installations.map((installation) => {
        return buildTelegramBot(installation, authCtx.userId);
      }),
    );

    return { status: 200 as const, body: { bots } };
  },
});

const handler = createHandler(integrationsTelegramBotListContract, router, {
  routeName: "zero.integrations.telegram.bots",
});

export { handler as GET };
