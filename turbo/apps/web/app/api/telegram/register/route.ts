import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import {
  getMe,
  setWebhook,
  setMyCommands,
} from "../../../../src/lib/zero/telegram/client";
import { encryptSecretValue } from "../../../../src/lib/shared/crypto/secrets-encryption";
import { generateCallbackSecret } from "../../../../src/lib/infra/callback/hmac";
import { logger } from "../../../../src/lib/shared/logger";
import { buildTelegramWebhookUrl } from "../../../../src/lib/zero/telegram/webhook-url";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { buildTelegramBotStatus } from "../../integrations/telegram/telegram-status";
import { getWorkspaceAgentDisplayLabel } from "../../../../src/lib/zero/telegram/handlers/shared";
import { publishTelegramOrgChangedSafely } from "../../../../src/lib/zero/telegram/realtime";

const registerBodySchema = z.object({
  botToken: z.string().min(1),
  defaultAgentId: z.string().trim().min(1).optional(),
  reinstallBotId: z.string().min(1).optional(),
});

type RegisterBody = z.infer<typeof registerBodySchema>;
type TelegramBotInfo = Awaited<ReturnType<typeof getMe>>;

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

function badRequestResponse(message: string) {
  return NextResponse.json(
    { error: { message, code: "BAD_REQUEST" } },
    { status: 400 },
  );
}

function forbiddenResponse(message: string) {
  return NextResponse.json(
    { error: { message, code: "FORBIDDEN" } },
    { status: 403 },
  );
}

async function resolveDefaultAgentId(params: {
  requestedAgentId: string | undefined;
  fallbackAgentId: string | undefined;
  orgId: string;
}): Promise<string | NextResponse> {
  let defaultAgentId = params.requestedAgentId ?? params.fallbackAgentId;
  if (!defaultAgentId) {
    const [metadata] = await globalThis.services.db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, params.orgId))
      .limit(1);
    defaultAgentId = metadata?.defaultAgentId ?? undefined;
  }

  if (!defaultAgentId) {
    return badRequestResponse(
      "No default agent specified. Provide defaultAgentId or configure a default agent for the active organization.",
    );
  }

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
  if (compose.orgId !== params.orgId) {
    return forbiddenResponse(
      "Telegram bots can only be connected to agents in the active organization.",
    );
  }

  return compose.id;
}

async function configureTelegramBot(params: {
  botToken: string;
  telegramBotId: string;
  webhookSecret: string;
  requestUrl: string;
  agentName: string;
}): Promise<NextResponse | undefined> {
  const baseUrl = getWebhookBaseUrl(params.requestUrl);
  const webhookUrl = buildTelegramWebhookUrl(baseUrl, params.telegramBotId);

  try {
    await setWebhook(params.botToken, webhookUrl, params.webhookSecret);
  } catch (error) {
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

  await setMyCommands(params.botToken, [
    { command: "new_session", description: "Start a new conversation" },
    { command: "connect", description: `Connect to ${params.agentName}` },
    { command: "model", description: "Choose your personal default model" },
    {
      command: "disconnect",
      description: `Disconnect from ${params.agentName}`,
    },
    { command: "help", description: "Show available commands" },
  ]).catch((error) => {
    log.warn("Failed to register bot commands", { error });
  });

  return undefined;
}

async function handleExistingInstallation(params: {
  existing: typeof telegramInstallations.$inferSelect;
  body: RegisterBody;
  botInfo: TelegramBotInfo;
  userId: string;
  orgId: string;
  memberRole: string;
  requestUrl: string;
  secretsEncryptionKey: string;
}): Promise<NextResponse> {
  const {
    existing,
    body,
    botInfo,
    userId,
    orgId,
    memberRole,
    requestUrl,
    secretsEncryptionKey,
  } = params;

  if (!body.reinstallBotId) {
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

  if (existing.orgId !== orgId) {
    return NextResponse.json(
      {
        error: {
          message:
            "This Telegram bot is already installed in another workspace.",
          code: "CONFLICT",
        },
      },
      { status: 409 },
    );
  }

  if (existing.ownerUserId !== userId && memberRole !== "admin") {
    return forbiddenResponse(
      "Only the bot owner or an org admin can reinstall this bot",
    );
  }

  const resolvedAgentId = await resolveDefaultAgentId({
    requestedAgentId: body.defaultAgentId,
    fallbackAgentId: existing.defaultComposeId,
    orgId,
  });
  if (resolvedAgentId instanceof NextResponse) {
    return resolvedAgentId;
  }

  const webhookSecret = generateCallbackSecret();
  const agentName = await getWorkspaceAgentDisplayLabel(resolvedAgentId);
  const configureError = await configureTelegramBot({
    botToken: body.botToken,
    telegramBotId: existing.telegramBotId,
    webhookSecret,
    requestUrl,
    agentName,
  });
  if (configureError) {
    return configureError;
  }

  const encryptedBotToken = encryptSecretValue(
    body.botToken,
    secretsEncryptionKey,
  );
  const [updated] = await globalThis.services.db
    .update(telegramInstallations)
    .set({
      botUsername: botInfo.username,
      encryptedBotToken,
      webhookSecret,
      defaultComposeId: resolvedAgentId,
      updatedAt: new Date(),
    })
    .where(eq(telegramInstallations.telegramBotId, existing.telegramBotId))
    .returning();

  await publishTelegramOrgChangedSafely(orgId);

  return NextResponse.json(
    await buildTelegramBotStatus(updated ?? existing, userId, "valid"),
  );
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
  const { org, member } = await resolveOrg(authCtx);
  const userId = authCtx.userId;

  const parseResult = registerBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    const invalidField = parseResult.error.issues[0]?.path[0];
    const message =
      invalidField === "defaultAgentId"
        ? "defaultAgentId must be non-empty"
        : "botToken is required";
    return badRequestResponse(message);
  }
  const body = parseResult.data;

  const { SECRETS_ENCRYPTION_KEY } = env();

  // 1. Verify bot token
  const botInfoResult = await getMe(body.botToken).catch(() => {
    return null;
  });
  if (!botInfoResult) {
    return badRequestResponse(
      "Invalid bot token. Please verify your token with @BotFather.",
    );
  }

  const telegramBotId = String(botInfoResult.id);
  if (body.reinstallBotId && body.reinstallBotId !== telegramBotId) {
    return badRequestResponse(
      "This token belongs to a different Telegram bot. Paste the token for the selected bot.",
    );
  }

  // 2. Check for duplicate. Reinstall is explicit; regular duplicate add
  // still tells the user to connect instead of silently replacing credentials.
  const [existing] = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, telegramBotId))
    .limit(1);

  if (existing) {
    return handleExistingInstallation({
      existing,
      body,
      botInfo: botInfoResult,
      userId,
      orgId: org.orgId,
      memberRole: member.role,
      requestUrl: request.url,
      secretsEncryptionKey: SECRETS_ENCRYPTION_KEY,
    });
  }

  if (body.reinstallBotId) {
    return NextResponse.json(
      { error: { message: "Telegram bot not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // 3. Resolve default agent
  const resolvedAgentId = await resolveDefaultAgentId({
    requestedAgentId: body.defaultAgentId,
    fallbackAgentId: undefined,
    orgId: org.orgId,
  });
  if (resolvedAgentId instanceof NextResponse) {
    return resolvedAgentId;
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
      defaultComposeId: resolvedAgentId,
      ownerUserId: userId,
      orgId: org.orgId,
    })
    .returning();

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Failed to create installation", code: "INTERNAL" } },
      { status: 500 },
    );
  }

  // 6. Set webhook and commands with Telegram
  const agentName = await getWorkspaceAgentDisplayLabel(resolvedAgentId);
  const configureError = await configureTelegramBot({
    botToken: body.botToken,
    telegramBotId: installation.telegramBotId,
    webhookSecret,
    requestUrl: request.url,
    agentName,
  });
  if (configureError) {
    // Rollback: delete the installation
    await globalThis.services.db
      .delete(telegramInstallations)
      .where(
        eq(telegramInstallations.telegramBotId, installation.telegramBotId),
      );

    return configureError;
  }

  await publishTelegramOrgChangedSafely(org.orgId);

  return NextResponse.json(
    await buildTelegramBotStatus(installation, userId, "valid"),
    {
      status: 201,
    },
  );
}
