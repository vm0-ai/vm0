import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { telegramInstallations } from "../../../../src/db/schema/telegram-installation";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import {
  getMe,
  setWebhook,
  setMyCommands,
} from "../../../../src/lib/zero/telegram/client";
import { encryptSecretValue } from "../../../../src/lib/shared/crypto/secrets-encryption";
import { generateCallbackSecret } from "../../../../src/lib/infra/callback/hmac";
import { resolveDefaultAgentComposeId } from "../../../../src/lib/infra/agent-compose/resolve-default";
import { logger } from "../../../../src/lib/shared/logger";
import { checkTelegramDomain } from "../../../../src/lib/zero/telegram/check-domain";
import { buildTelegramWebhookUrl } from "../../../../src/lib/zero/telegram/webhook-url";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";

const registerBodySchema = z.object({
  botToken: z.string().min(1),
  defaultAgentId: z.string().optional(),
});

const log = logger("api:telegram:register");

/**
 * Resolve webhook base URL from the request.
 * Uses VM0_API_URL when set, falls back to request origin.
 */
function getWebhookBaseUrl(requestUrl: string): string {
  const { VM0_API_URL } = env();
  if (VM0_API_URL) {
    return VM0_API_URL;
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
  const authCtx = await getAuthContext(authHeader ?? undefined);

  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { org } = await resolveOrg(authCtx);
  const userId = authCtx.userId;

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
  const botInfoResult = await getMe(body.botToken).catch(() => {
    return null;
  });
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

  // 2. Check for duplicate — if bot already registered, link the user instead
  const [existing] = await globalThis.services.db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      botUsername: telegramInstallations.botUsername,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, telegramBotId))
    .limit(1);

  if (existing) {
    return NextResponse.json(
      {
        error: {
          message: `This bot is already installed. Use /connect in Telegram (@${existing.botUsername}) to link your account.`,
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

  // Verify agent exists and snapshot its orgId for installation anchoring
  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id, orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, defaultAgentId))
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Agent not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }
  if (compose.orgId !== org.orgId) {
    return NextResponse.json(
      {
        error: {
          message:
            "Telegram bots can only be connected to agents in the active organization.",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // 4. Encrypt token and generate webhook secret
  const encryptedBotToken = encryptSecretValue(
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
      ownerUserId: userId,
      orgId: compose.orgId,
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
  const webhookUrl = buildTelegramWebhookUrl(
    baseUrl,
    installation.telegramBotId,
  );

  try {
    await setWebhook(body.botToken, webhookUrl, webhookSecret);
  } catch (error) {
    // Rollback: delete the installation
    await globalThis.services.db
      .delete(telegramInstallations)
      .where(
        eq(telegramInstallations.telegramBotId, installation.telegramBotId),
      );

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
    { command: "help", description: "Show available commands" },
  ]).catch((error) => {
    log.warn("Failed to register bot commands", { error });
  });

  // Check if domain is configured for Telegram OAuth
  const { NEXT_PUBLIC_APP_URL } = env();
  const domainConfigured = await checkTelegramDomain(
    telegramBotId,
    NEXT_PUBLIC_APP_URL,
  );

  return NextResponse.json(
    {
      id: installation.telegramBotId,
      botId: telegramBotId,
      botUsername: botInfoResult.username,
      webhookUrl,
      domainConfigured,
    },
    { status: 201 },
  );
}
