import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { buildTelegramBot } from "./telegram-status";

/**
 * GET /api/integrations/telegram
 *
 * Lists Telegram bots owned by the authenticated user in the active org.
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

  const { userId } = authCtx;
  const { org } = await resolveOrg(authCtx);

  const installations = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(
      and(
        eq(telegramInstallations.ownerUserId, userId),
        eq(telegramInstallations.orgId, org.orgId),
      ),
    )
    .orderBy(
      desc(telegramInstallations.createdAt),
      desc(telegramInstallations.telegramBotId),
    );

  const bots = await Promise.all(
    installations.map((installation) => {
      return buildTelegramBot(installation, userId);
    }),
  );

  return NextResponse.json({ bots });
}
