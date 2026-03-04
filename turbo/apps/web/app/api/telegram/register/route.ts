import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { telegramInstallations } from "../../../../src/db/schema/telegram-installation";
import { telegramUserLinks } from "../../../../src/db/schema/telegram-user-link";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { scopes } from "../../../../src/db/schema/scope";
import {
  getMe,
  setWebhook,
  setMyCommands,
} from "../../../../src/lib/telegram/client";
import { encryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import { generateCallbackSecret } from "../../../../src/lib/callback/hmac";
import { logger } from "../../../../src/lib/logger";

const registerBodySchema = z.object({
  botToken: z.string().min(1),
  defaultAgentId: z.string().optional(),
});

const log = logger("api:telegram:register");

/**
 * Resolve webhook base URL from the request.
 * Uses VERCEL_URL in production, falls back to request origin.
 */
function getWebhookBaseUrl(requestUrl: string): string {
  const { VERCEL_URL } = env();
  if (VERCEL_URL) {
    return `https://${VERCEL_URL}`;
  }
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
}

/**
 * Resolve the default agent compose ID from TELEGRAM_DEFAULT_AGENT env var.
 * Format: "scope-slug/agent-name"
 */
async function resolveDefaultAgent(): Promise<string | null> {
  const { TELEGRAM_DEFAULT_AGENT } = env();
  if (!TELEGRAM_DEFAULT_AGENT) return null;

  const [scopeSlug, agentName] = TELEGRAM_DEFAULT_AGENT.split("/");
  if (!scopeSlug || !agentName) return null;

  const [scope] = await globalThis.services.db
    .select({ id: scopes.id })
    .from(scopes)
    .where(eq(scopes.slug, scopeSlug))
    .limit(1);

  if (!scope) return null;

  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.scopeId, scope.id),
        eq(agentComposes.name, agentName),
      ),
    )
    .limit(1);

  return compose?.id ?? null;
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
  const defaultAgentId = body.defaultAgentId ?? (await resolveDefaultAgent());
  if (!defaultAgentId) {
    return NextResponse.json(
      {
        error: {
          message:
            "No default agent specified. Provide defaultAgentId or set TELEGRAM_DEFAULT_AGENT env var.",
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
    { command: "start", description: "Link your account" },
    { command: "help", description: "Show help" },
  ]).catch((error) => {
    log.warn("Failed to register bot commands", { error });
  });

  // 8. Auto-create user link for the registering admin
  await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      telegramUserId: telegramBotId,
      installationId: installation.id,
      vm0UserId: userId,
    })
    .onConflictDoNothing();

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
