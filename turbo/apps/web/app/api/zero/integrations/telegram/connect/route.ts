import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { env } from "../../../../../../src/env";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { telegramInstallations } from "../../../../../../src/db/schema/telegram-installation";
import { telegramUserLinks } from "../../../../../../src/db/schema/telegram-user-link";
import { decryptSecretValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import {
  verifyTelegramLogin,
  telegramAuthSchema,
} from "../../../../../../src/lib/telegram/verify-login";
import { verifyConnectSignature } from "../../../../../../src/lib/telegram/connect-token";
import {
  ensureOrgAndArtifact,
  getWorkspaceAgent,
} from "../../../../../../src/lib/telegram/handlers/shared";
import {
  createTelegramClient,
  sendMessage,
} from "../../../../../../src/lib/telegram/client";
import { escapeHtml } from "../../../../../../src/lib/telegram/format";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("api:zero:telegram:connect");

const connectSignatureSchema = z.object({
  telegramUserId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
});

const connectBodySchema = z.object({
  telegramAuth: telegramAuthSchema.optional(),
  connectSignature: connectSignatureSchema.optional(),
});

/**
 * POST /api/zero/integrations/telegram/connect
 *
 * Connect user's Telegram identity to the org's bot.
 * Accepts Telegram Login Widget auth data or connect signature from /connect command.
 */
export async function POST(request: Request) {
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
  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org } = await resolveOrg(authCtx, orgSlug);

  const parseResult = connectBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { message: "Invalid request body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  const { SECRETS_ENCRYPTION_KEY } = env();
  const db = globalThis.services.db;

  // Find installation for this org
  const [installation] = await db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, org.orgId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      {
        error: {
          message: "No Telegram bot installed for this organization",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );

  // Verify via Telegram Login Widget
  if (body.telegramAuth) {
    if (!verifyTelegramLogin(body.telegramAuth, botToken)) {
      return NextResponse.json(
        {
          error: {
            message: "Invalid Telegram authorization",
            code: "BAD_REQUEST",
          },
        },
        { status: 400 },
      );
    }

    const telegramUserId = String(body.telegramAuth.id);

    await db
      .insert(telegramUserLinks)
      .values({
        telegramUserId,
        installationId: installation.id,
        vm0UserId: userId,
      })
      .onConflictDoUpdate({
        target: [
          telegramUserLinks.telegramUserId,
          telegramUserLinks.installationId,
        ],
        set: { vm0UserId: userId, updatedAt: new Date() },
      });
    await ensureOrgAndArtifact(userId);

    return NextResponse.json({
      botUsername: installation.botUsername,
      telegramUserId,
    });
  }

  // Verify via connect signature (from /connect command)
  if (body.connectSignature) {
    if (
      !verifyConnectSignature(
        installation.id,
        body.connectSignature.telegramUserId,
        body.connectSignature.timestamp,
        body.connectSignature.signature,
        botToken,
      )
    ) {
      return NextResponse.json(
        {
          error: {
            message:
              "Invalid or expired connect link. Please use /connect again in Telegram.",
            code: "BAD_REQUEST",
          },
        },
        { status: 400 },
      );
    }

    const telegramUserId = body.connectSignature.telegramUserId;

    await db
      .insert(telegramUserLinks)
      .values({
        telegramUserId,
        installationId: installation.id,
        vm0UserId: userId,
      })
      .onConflictDoUpdate({
        target: [
          telegramUserLinks.telegramUserId,
          telegramUserLinks.installationId,
        ],
        set: { vm0UserId: userId, updatedAt: new Date() },
      });
    await ensureOrgAndArtifact(userId);

    // Send success message in Telegram (non-blocking)
    const client = createTelegramClient(botToken);
    const agent = await getWorkspaceAgent(installation.defaultComposeId);
    const agentName = agent?.name ?? "Agent";
    sendMessage(
      client,
      telegramUserId,
      `✅ Account connected! 🤖 ${escapeHtml(agentName)} is ready.\n\nSend me a message to get started.`,
    ).catch((err) => {
      log.warn("Failed to send connect success message", { err });
    });

    return NextResponse.json({
      botUsername: installation.botUsername,
      telegramUserId,
    });
  }

  return NextResponse.json(
    {
      error: {
        message: "Either telegramAuth or connectSignature is required",
        code: "BAD_REQUEST",
      },
    },
    { status: 400 },
  );
}
