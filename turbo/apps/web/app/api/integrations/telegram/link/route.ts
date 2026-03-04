import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { telegramUserLinks } from "../../../../../src/db/schema/telegram-user-link";
import { telegramInstallations } from "../../../../../src/db/schema/telegram-installation";
import { createLinkToken } from "../../../../../src/lib/telegram/handlers/start";

const linkBodySchema = z.object({
  installationId: z.string().min(1),
});

/**
 * GET /api/integrations/telegram/link
 *
 * Check if the authenticated user is linked to a Telegram bot.
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  // Find user's most recent Telegram link
  const [userLink] = await globalThis.services.db
    .select({
      telegramUserId: telegramUserLinks.telegramUserId,
      installationId: telegramUserLinks.installationId,
    })
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.vm0UserId, userId))
    .orderBy(desc(telegramUserLinks.createdAt))
    .limit(1);

  if (!userLink) {
    return NextResponse.json({ linked: false });
  }

  return NextResponse.json({
    linked: true,
    telegramUserId: userLink.telegramUserId,
  });
}

/**
 * POST /api/integrations/telegram/link
 *
 * Generate a deep link token for account linking via Telegram.
 * Body: { installationId: string }
 */
export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const parseResult = linkBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: {
          message: "installationId is required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  // Look up installation to get botUsername
  const [installation] = await globalThis.services.db
    .select({
      id: telegramInstallations.id,
      botUsername: telegramInstallations.botUsername,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.id, body.installationId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Installation not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  const { SECRETS_ENCRYPTION_KEY } = env();

  const token = createLinkToken(
    userId,
    installation.id,
    SECRETS_ENCRYPTION_KEY,
  );

  const deepLink = installation.botUsername
    ? `https://t.me/${installation.botUsername}?start=${token}`
    : null;

  return NextResponse.json({ token, deepLink });
}
