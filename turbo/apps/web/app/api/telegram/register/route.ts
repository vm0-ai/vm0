import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { telegramInstallations } from "../../../../src/db/schema/telegram-installation";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import {
  getMe,
  setWebhook,
  setMyCommands,
} from "../../../../src/lib/telegram/client";
import { encryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import { generateCallbackSecret } from "../../../../src/lib/callback/hmac";
import { resolveDefaultAgentComposeId } from "../../../../src/lib/agent-compose/resolve-default";
import { telegramUserLinks } from "../../../../src/db/schema/telegram-user-link";
import {
  ensureScopeAndArtifact,
  PENDING_TELEGRAM_USER_ID,
} from "../../../../src/lib/telegram/handlers/shared";
import { logger } from "../../../../src/lib/logger";

const registerBodySchema = z.object({
  botToken: z.string().min(1),
  defaultAgentId: z.string().optional(),
});

const log = logger("api:telegram:register");

/**
 * Resolve webhook base URL from the request.
 * Uses VM0_TUNNEL_URL for local dev, VERCEL_URL in production, falls back to request origin.
 */
function getWebhookBaseUrl(requestUrl: string): string {
  const { VM0_TUNNEL_URL, VERCEL_URL } = env();
  if (VM0_TUNNEL_URL) {
    return VM0_TUNNEL_URL;
  }
  if (VERCEL_URL) {
    return `https://${VERCEL_URL}`;
  }
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
}

/**
 * POST /api/telegram/register
 *
 * Register a Telegram bot with VM0.
 * Body: { botToken: string, defaultAgentId?: string }
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

  const parseResult = registerBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { message: "botToken is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  const { SECRETS_ENCRYPTION_KEY } = env();

  // 1. Verify bot token
  const botInfoResult = await getMe(body.botToken).catch(() => null);
  if (!botInfoResult) {
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

  const telegramBotId = String(botInfoResult.id);

  // 2. Check for duplicate
  const [existing] = await globalThis.services.db
    .select({ id: telegramInstallations.id })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, telegramBotId))
    .limit(1);

  if (existing) {
    return NextResponse.json(
      {
        error: {
          message: "This bot is already registered",
          code: "CONFLICT",
        },
      },
      { status: 409 },
    );
  }

  // 3. Resolve default agent
  const defaultAgentId =
    body.defaultAgentId ?? (await resolveDefaultAgentComposeId());
  if (!defaultAgentId) {
    return NextResponse.json(
      {
        error: {
          message:
            "No default agent specified. Provide defaultAgentId or set VM0_DEFAULT_AGENT env var.",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // Verify agent exists
  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(eq(agentComposes.id, defaultAgentId))
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Agent not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // 4. Encrypt token and generate webhook secret
  const encryptedBotToken = encryptCredentialValue(
    body.botToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const webhookSecret = generateCallbackSecret();

  // 5. Insert installation
  const [installation] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId,
      botUsername: botInfoResult.username,
      encryptedBotToken,
      webhookSecret,
      defaultComposeId: defaultAgentId,
      adminUserId: userId,
    })
    .returning();

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Failed to create installation", code: "INTERNAL" } },
      { status: 500 },
    );
  }

  // 6. Set webhook with Telegram
  const baseUrl = getWebhookBaseUrl(request.url);
  const webhookUrl = `${baseUrl}/api/telegram/webhook/${installation.id}`;

  try {
    await setWebhook(body.botToken, webhookUrl, webhookSecret);
  } catch (error) {
    // Rollback: delete the installation
    await globalThis.services.db
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

  // 7. Register bot commands (non-blocking)
  await setMyCommands(body.botToken, [
    { command: "new_session", description: "Start a new conversation" },
    { command: "connect", description: "Connect your VM0 account" },
    { command: "disconnect", description: "Disconnect your account" },
    { command: "settings", description: "Open platform settings" },
    { command: "help", description: "Show available commands" },
  ]).catch((error) => {
    log.warn("Failed to register bot commands", { error });
  });

  // 8. Create pending user link so the admin is auto-linked on first message
  await globalThis.services.db.insert(telegramUserLinks).values({
    telegramUserId: PENDING_TELEGRAM_USER_ID,
    installationId: installation.id,
    vm0UserId: userId,
  });
  await ensureScopeAndArtifact(userId);

  return NextResponse.json(
    {
      id: installation.id,
      botId: telegramBotId,
      botUsername: botInfoResult.username,
      webhookUrl,
    },
    { status: 201 },
  );
}
