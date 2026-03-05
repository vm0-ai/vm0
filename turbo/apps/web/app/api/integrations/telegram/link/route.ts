import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { telegramUserLinks } from "../../../../../src/db/schema/telegram-user-link";
import { telegramInstallations } from "../../../../../src/db/schema/telegram-installation";
import {
  ensureScopeAndArtifact,
  getWorkspaceAgent,
  PENDING_TELEGRAM_USER_ID,
} from "../../../../../src/lib/telegram/handlers/shared";
import { decryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { env } from "../../../../../src/env";
import {
  createTelegramClient,
  sendMessage,
} from "../../../../../src/lib/telegram/client";
import { escapeHtml } from "../../../../../src/lib/telegram/format";
import { logger } from "../../../../../src/lib/logger";

const log = logger("telegram:link");

const linkBodySchema = z.object({
  installationId: z.string().min(1),
  telegramUserId: z.string().min(1).optional(),
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

  if (userLink) {
    return NextResponse.json({
      linked: true,
      telegramUserId: userLink.telegramUserId,
    });
  }

  // If not linked, check if a specific bot was requested via ?botId= param.
  // Returns installation info so the frontend can show a re-link UI.
  // Actual linking creates a pending user link that auto-completes on first
  // Telegram message (see resolveUserLink in shared.ts).
  const url = new URL(request.url);
  const botId = url.searchParams.get("botId");

  if (botId) {
    const [installation] = await globalThis.services.db
      .select({
        id: telegramInstallations.id,
        botUsername: telegramInstallations.botUsername,
      })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId))
      .limit(1);

    if (installation) {
      return NextResponse.json({
        linked: false,
        installation: {
          id: installation.id,
          botUsername: installation.botUsername,
        },
      });
    }
  }

  return NextResponse.json({ linked: false });
}

/**
 * POST /api/integrations/telegram/link
 *
 * Create a pending user link for account linking via Telegram.
 * The link auto-completes when the user sends their first message to the bot.
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

  // Look up installation to get botUsername and bot token
  const [installation] = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.id, body.installationId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Installation not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  const telegramUserId = body.telegramUserId ?? PENDING_TELEGRAM_USER_ID;

  // Create user link (real if telegramUserId provided, pending otherwise)
  await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      telegramUserId,
      installationId: installation.id,
      vm0UserId: userId,
    })
    .onConflictDoNothing();
  await ensureScopeAndArtifact(userId);

  // Send confirmation message via bot if we have a real telegramUserId
  if (body.telegramUserId) {
    try {
      const { SECRETS_ENCRYPTION_KEY } = env();
      const botToken = decryptCredentialValue(
        installation.encryptedBotToken,
        SECRETS_ENCRYPTION_KEY,
      );
      const client = createTelegramClient(botToken);
      const agent = await getWorkspaceAgent(installation.defaultComposeId);
      const agentName = agent?.name ?? "Agent";
      await sendMessage(
        client,
        body.telegramUserId,
        `🎉 Account connected! 🤖 ${escapeHtml(agentName)} is ready.\n\nSend a message to start chatting.`,
      );
    } catch (error) {
      log.warn("Failed to send connect confirmation", { error });
    }
  }

  const botLink = installation.botUsername
    ? `https://t.me/${installation.botUsername}`
    : null;

  return NextResponse.json({ botUsername: installation.botUsername, botLink });
}
