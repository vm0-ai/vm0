import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { buildOfficialTelegramBot, buildTelegramBot } from "./telegram-status";
import { loadFeatureSwitchOverrides } from "../../../../src/lib/zero/user/feature-switches-service";

/**
 * GET /api/integrations/telegram
 *
 * Lists Telegram bots installed in the authenticated user's active org.
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);

  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { org } = await resolveOrg(authCtx);
  const overrides = await loadFeatureSwitchOverrides(org.orgId, authCtx.userId);
  const officialTelegramEnabled = isFeatureEnabled(
    FeatureSwitchKey.OfficialTelegramBot,
    {
      userId: authCtx.userId,
      orgId: org.orgId,
      overrides,
    },
  );

  const installations = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, org.orgId))
    .orderBy(
      desc(telegramInstallations.createdAt),
      desc(telegramInstallations.telegramBotId),
    );

  const customBots = await Promise.all(
    installations.map((installation) => {
      return buildTelegramBot(installation, authCtx.userId);
    }),
  );
  const bots = officialTelegramEnabled
    ? [
        await buildOfficialTelegramBot({
          orgId: org.orgId,
          userId: authCtx.userId,
        }),
        ...customBots,
      ]
    : customBots;

  return NextResponse.json({ bots });
}
