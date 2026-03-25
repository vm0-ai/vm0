import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { env } from "../../../../../../src/env";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { telegramInstallations } from "../../../../../../src/db/schema/telegram-installation";
import { telegramUserLinks } from "../../../../../../src/db/schema/telegram-user-link";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import {
  getMe,
  setWebhook,
  setMyCommands,
} from "../../../../../../src/lib/telegram/client";
import { encryptSecretValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { generateCallbackSecret } from "../../../../../../src/lib/callback/hmac";
import {
  verifyTelegramLogin,
  telegramAuthSchema,
} from "../../../../../../src/lib/telegram/verify-login";
import { resolveDefaultComposeId } from "../../../../../../src/lib/slack-org/handlers/shared";
import { getApiUrl } from "../../../../../../src/lib/callback";
import { ensureOrgAndArtifact } from "../../../../../../src/lib/telegram/handlers/shared";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("api:zero:telegram:install");

const installBodySchema = z.object({
  botToken: z.string().min(1),
  telegramAuth: telegramAuthSchema,
});

/**
 * Resolve webhook base URL from env.
 */
function getWebhookBaseUrl(): string {
  const { VM0_TUNNEL_URL, VERCEL_URL } = env();
  if (VM0_TUNNEL_URL) return VM0_TUNNEL_URL;
  if (VERCEL_URL) return `https://${VERCEL_URL}`;
  return getApiUrl();
}

/**
 * POST /api/zero/integrations/telegram/install
 *
 * Install a Telegram bot for the org. Admin only.
 * Accepts bot token + Telegram Login Widget auth data.
 * Creates installation and auto-connects the admin.
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
  const { org, member } = await resolveOrg(authCtx, orgSlug);

  if (member.role !== "admin") {
    return NextResponse.json(
      { error: { message: "Admin access required", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  const parseResult = installBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: {
          message: "botToken and telegramAuth are required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  const { SECRETS_ENCRYPTION_KEY } = env();
  const db = globalThis.services.db;

  // 1. Validate bot token
  let botInfo;
  try {
    botInfo = await getMe(body.botToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Telegram API error")) {
      return NextResponse.json(
        {
          error: {
            message:
              "Invalid bot token. Please verify your token with @BotFather.",
            code: "BAD_REQUEST",
          },
        },
        { status: 400 },
      );
    }
    log.error("Failed to validate bot token", { error });
    return NextResponse.json(
      {
        error: {
          message: "Failed to reach Telegram API",
          code: "BAD_GATEWAY",
        },
      },
      { status: 502 },
    );
  }

  const telegramBotId = String(botInfo.id);

  // 2. Check if org already has a bot
  const [existingOrgBot] = await db
    .select({ id: telegramInstallations.id })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, org.orgId))
    .limit(1);

  if (existingOrgBot) {
    return NextResponse.json(
      {
        error: {
          message: "This organization already has a Telegram bot installed.",
          code: "CONFLICT",
        },
      },
      { status: 409 },
    );
  }

  // 3. Check if bot is already registered for another org
  const [existingBot] = await db
    .select({
      id: telegramInstallations.id,
      orgId: telegramInstallations.orgId,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, telegramBotId))
    .limit(1);

  if (existingBot) {
    return NextResponse.json(
      {
        error: {
          message:
            "This bot is already registered. Use /connect in Telegram to link your account.",
          code: "CONFLICT",
        },
      },
      { status: 409 },
    );
  }

  // 4. Verify Telegram Login Widget auth
  if (!verifyTelegramLogin(body.telegramAuth, body.botToken)) {
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

  // 5. Resolve default agent
  const defaultComposeId = await resolveDefaultComposeId(org.orgId);
  if (!defaultComposeId) {
    return NextResponse.json(
      {
        error: {
          message:
            "No default agent configured. Please set a default agent for your organization.",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // Verify agent exists
  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(eq(agentComposes.id, defaultComposeId))
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Default agent not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // 6. Encrypt token and generate webhook secret
  const encryptedBotToken = encryptSecretValue(
    body.botToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const webhookSecret = generateCallbackSecret();

  // 7. Create installation
  const [installation] = await db
    .insert(telegramInstallations)
    .values({
      telegramBotId,
      botUsername: botInfo.username,
      encryptedBotToken,
      webhookSecret,
      defaultComposeId,
      adminUserId: userId,
      orgId: org.orgId,
    })
    .returning();

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Failed to create installation", code: "INTERNAL" } },
      { status: 500 },
    );
  }

  // 8. Set webhook
  const baseUrl = getWebhookBaseUrl();
  const webhookUrl = `${baseUrl}/api/telegram/webhook/${installation.id}`;

  try {
    await setWebhook(body.botToken, webhookUrl, webhookSecret);
  } catch (error) {
    // Rollback: delete the installation
    await db
      .delete(telegramInstallations)
      .where(eq(telegramInstallations.id, installation.id));

    log.error("Failed to set Telegram webhook", { error });
    return NextResponse.json(
      {
        error: {
          message: "Failed to register webhook with Telegram",
          code: "BAD_GATEWAY",
        },
      },
      { status: 502 },
    );
  }

  // 9. Register bot commands (best-effort)
  await setMyCommands(body.botToken, [
    { command: "new_session", description: "Start a new conversation" },
    { command: "connect", description: "Connect your VM0 account" },
    { command: "disconnect", description: "Disconnect your account" },
    { command: "settings", description: "Open platform settings" },
    { command: "help", description: "Show available commands" },
  ]).catch((error) => {
    log.warn("Failed to register bot commands", { error });
  });

  // 10. Auto-connect admin (create user link)
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

  log.info("Telegram bot installed", {
    installationId: installation.id,
    botId: telegramBotId,
    orgId: org.orgId,
    adminUserId: userId,
  });

  return NextResponse.json(
    {
      installationId: installation.id,
      bot: {
        id: telegramBotId,
        username: botInfo.username,
      },
    },
    { status: 201 },
  );
}
