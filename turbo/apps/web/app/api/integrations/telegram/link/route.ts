import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import {
  ensureOrgAndArtifact,
  formatTelegramUserDisplayName,
  formatTelegramCommandSuccess,
  linkTelegramUserToVm0User,
  type LinkTelegramUserResult,
} from "../../../../../src/lib/zero/telegram/handlers/shared";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import {
  createTelegramClient,
  sendMessage,
} from "../../../../../src/lib/zero/telegram/client";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  telegramAuthSchema,
  verifyTelegramLogin,
} from "../../../../../src/lib/zero/telegram/verify-login";
import { verifyConnectSignature } from "../../../../../src/lib/zero/telegram/connect-token";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { checkTelegramDomain } from "../../../../../src/lib/zero/telegram/check-domain";
import { publishTelegramUserChangedSafely } from "../../../../../src/lib/zero/telegram/realtime";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  getOfficialTelegramBotConfig,
} from "../../../../../src/lib/zero/telegram/official";
import {
  ensureOfficialOrgAndArtifact,
  linkOfficialTelegramUserToVm0User,
  type LinkOfficialTelegramUserResult,
} from "../../../../../src/lib/zero/telegram/official-user";
const log = logger("api:telegram:link");

type LinkTelegramUserConflictReason = Extract<
  LinkTelegramUserResult,
  { ok: false }
>["reason"];
type LinkOfficialTelegramUserConflictReason = Extract<
  LinkOfficialTelegramUserResult,
  { ok: false }
>["reason"];

function orgMismatchResponse() {
  return NextResponse.json(
    {
      error: {
        message:
          "This Telegram bot belongs to a different organization. Switch to the bot's organization to connect.",
        code: "FORBIDDEN",
      },
    },
    { status: 403 },
  );
}

function resolveTelegramLoginOrigin(request: Request): string {
  const { NEXT_PUBLIC_APP_URL } = env();
  const url = new URL(request.url);
  const originParam = url.searchParams.get("origin");
  if (!originParam) {
    return NEXT_PUBLIC_APP_URL;
  }

  try {
    const originUrl = new URL(originParam);
    if (originUrl.protocol === "http:" || originUrl.protocol === "https:") {
      return originUrl.origin;
    }
  } catch {
    // Fall back to the configured app URL for malformed client origins.
  }

  return NEXT_PUBLIC_APP_URL;
}

function linkConflictResponse(reason: LinkTelegramUserConflictReason) {
  const message =
    reason === "telegram-user-linked"
      ? "This Telegram account is already connected to another VM0 account for this bot. Disconnect it before connecting a different account."
      : reason === "vm0-user-linked"
        ? "Your VM0 account is already connected to another Telegram account for this bot. Disconnect it before connecting a different Telegram account."
        : "This Telegram account link already exists. Disconnect it first and try again.";

  return NextResponse.json(
    { error: { message, code: "CONFLICT" } },
    { status: 409 },
  );
}

function officialLinkConflictResponse(
  reason: LinkOfficialTelegramUserConflictReason,
) {
  const message =
    reason === "telegram-user-linked"
      ? "This Telegram account is already connected to another VM0 organization through the official Zero bot. Disconnect it before connecting a different account."
      : reason === "vm0-org-linked"
        ? "Your VM0 account is already connected to another Telegram account for the official Zero bot in this organization. Disconnect it before connecting a different Telegram account."
        : "This official Telegram account link already exists. Disconnect it first and try again.";

  return NextResponse.json(
    { error: { message, code: "CONFLICT" } },
    { status: 409 },
  );
}

function missingOfficialAgentResponse() {
  return NextResponse.json(
    {
      error: {
        message:
          "Finish onboarding before connecting Telegram. Telegram needs a default agent for this workspace.",
        code: "CONFLICT",
      },
    },
    { status: 409 },
  );
}

async function resolveOfficialConnectComposeId(
  userId: string,
  orgId: string,
): Promise<string | null> {
  const [preference] = await globalThis.services.db
    .select({
      selectedComposeId: telegramUserAgentPreferences.selectedComposeId,
    })
    .from(telegramUserAgentPreferences)
    .where(
      and(
        eq(telegramUserAgentPreferences.vm0UserId, userId),
        eq(telegramUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);

  const preferredComposeId = preference?.selectedComposeId ?? null;
  if (preferredComposeId) {
    const [compose] = await globalThis.services.db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.id, preferredComposeId),
          eq(agentComposes.orgId, orgId),
        ),
      )
      .limit(1);
    if (compose) {
      return compose.id;
    }
  }

  const [metadata] = await globalThis.services.db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  const defaultAgentId = metadata?.defaultAgentId ?? null;
  if (!defaultAgentId) {
    return null;
  }

  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(eq(agentComposes.id, defaultAgentId), eq(agentComposes.orgId, orgId)),
    )
    .limit(1);
  return compose?.id ?? null;
}

async function linkUserOrConflict(params: {
  installationId: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  telegramDisplayName?: string | null;
  vm0UserId: string;
  orgId: string;
}): Promise<NextResponse | undefined> {
  const result = await linkTelegramUserToVm0User(params);
  if (!result.ok) {
    return linkConflictResponse(result.reason);
  }

  await ensureOrgAndArtifact(params.vm0UserId, params.orgId);
  return undefined;
}

async function linkOfficialUserOrConflict(params: {
  telegramUserId: string;
  telegramUsername?: string | null;
  telegramDisplayName?: string | null;
  vm0UserId: string;
  orgId: string;
}): Promise<NextResponse | undefined> {
  const result = await linkOfficialTelegramUserToVm0User(params);
  if (!result.ok) {
    return officialLinkConflictResponse(result.reason);
  }

  await ensureOfficialOrgAndArtifact(params.vm0UserId, params.orgId);
  return undefined;
}

/**
 * DELETE /api/integrations/telegram/link
 *
 * Disconnect the authenticated user's Telegram account (remove user link).
 * Does not remove the bot installation.
 */
export async function DELETE(request: Request) {
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
  const url = new URL(request.url);
  const botId = url.searchParams.get("botId");

  const db = globalThis.services.db;

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    const deleted = await db
      .delete(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.vm0UserId, userId),
          eq(telegramOfficialUserLinks.orgId, org.orgId),
        ),
      )
      .returning({ id: telegramOfficialUserLinks.id });

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: { message: "No linked Telegram account", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }

    await publishTelegramUserChangedSafely(userId);

    return new NextResponse(null, { status: 204 });
  }

  // Single-statement delete scoped to the user's active org via a sub-select
  // over telegram_installations. Atomic — no race window between SELECT and
  // DELETE, and returning() tells us whether anything was removed.
  const orgInstallations = db
    .select({ telegramBotId: telegramInstallations.telegramBotId })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, org.orgId));

  const deleted = await db
    .delete(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.vm0UserId, userId),
        inArray(telegramUserLinks.installationId, orgInstallations),
        botId ? eq(telegramUserLinks.installationId, botId) : undefined,
      ),
    )
    .returning({ id: telegramUserLinks.id });

  if (deleted.length === 0) {
    return NextResponse.json(
      { error: { message: "No linked Telegram account", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  await publishTelegramUserChangedSafely(userId);

  return new NextResponse(null, { status: 204 });
}

const connectSignatureSchema = z.object({
  telegramUserId: z.string().min(1),
  telegramUsername: z.string().max(255).optional(),
  telegramDisplayName: z.string().max(255).optional(),
  timestamp: z.number(),
  signature: z.string().min(1),
});

const linkBodySchema = z.object({
  telegramBotId: z.string().min(1),
  telegramAuth: telegramAuthSchema.optional(),
  connectSignature: connectSignatureSchema.optional(),
});

type LinkBody = z.infer<typeof linkBodySchema>;

/**
 * GET /api/integrations/telegram/link
 *
 * Check if the authenticated user is linked to a Telegram bot.
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
  const userId = authCtx.userId;
  const url = new URL(request.url);
  const botId = url.searchParams.get("botId");
  const telegramLoginOrigin = resolveTelegramLoginOrigin(request);

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    const [officialLink] = await globalThis.services.db
      .select({
        telegramUserId: telegramOfficialUserLinks.telegramUserId,
      })
      .from(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.vm0UserId, userId),
          eq(telegramOfficialUserLinks.orgId, org.orgId),
        ),
      )
      .limit(1);

    const config = getOfficialTelegramBotConfig();
    if (officialLink) {
      return NextResponse.json({
        linked: true,
        telegramUserId: officialLink.telegramUserId,
        botUsername: config.botUsername ?? "Zero",
      });
    }

    const domainConfigured = config.botId
      ? await checkTelegramDomain(config.botId, telegramLoginOrigin)
      : false;

    return NextResponse.json({
      linked: false,
      installation: {
        id: OFFICIAL_TELEGRAM_BOT_ID,
        botUsername: config.botUsername ?? "Zero",
        ...(config.botId ? { loginBotId: config.botId } : {}),
        domainConfigured,
      },
    });
  }

  // Find user's Telegram link in the active org. When a botId is provided,
  // scope the status to that bot so links for other bots don't short-circuit
  // the connect page.
  const [userLink] = await globalThis.services.db
    .select({
      telegramUserId: telegramUserLinks.telegramUserId,
      installationId: telegramUserLinks.installationId,
      botUsername: telegramInstallations.botUsername,
    })
    .from(telegramUserLinks)
    .innerJoin(
      telegramInstallations,
      eq(telegramUserLinks.installationId, telegramInstallations.telegramBotId),
    )
    .where(
      and(
        eq(telegramUserLinks.vm0UserId, userId),
        eq(telegramInstallations.orgId, org.orgId),
        botId ? eq(telegramUserLinks.installationId, botId) : undefined,
      ),
    )
    .orderBy(desc(telegramUserLinks.createdAt))
    .limit(1);

  if (userLink) {
    return NextResponse.json({
      linked: true,
      telegramUserId: userLink.telegramUserId,
      botUsername: userLink.botUsername,
    });
  }

  // If not linked, check if a specific bot was requested via ?botId= param.
  // Returns installation info so the frontend can show a re-link UI.
  // Actual linking creates a pending user link that auto-completes on first
  // Telegram message (see resolveUserLink in shared.ts).
  if (botId) {
    const [installation] = await globalThis.services.db
      .select({
        telegramBotId: telegramInstallations.telegramBotId,
        botUsername: telegramInstallations.botUsername,
        orgId: telegramInstallations.orgId,
      })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId))
      .limit(1);

    if (installation) {
      if (installation.orgId !== org.orgId) {
        return orgMismatchResponse();
      }
      const domainConfigured = await checkTelegramDomain(
        installation.telegramBotId,
        telegramLoginOrigin,
      );
      return NextResponse.json({
        linked: false,
        installation: {
          id: installation.telegramBotId,
          botUsername: installation.botUsername,
          loginBotId: installation.telegramBotId,
          domainConfigured,
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
 * Body: { telegramBotId: string }
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

  const parseResult = linkBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: {
          message: "telegramBotId is required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  if (body.telegramBotId === OFFICIAL_TELEGRAM_BOT_ID) {
    return handleOfficialLinkPost(body, userId, org.orgId);
  }

  return handleCustomLinkPost(body, userId, org.orgId);
}

async function handleOfficialLinkPost(
  body: LinkBody,
  userId: string,
  orgId: string,
): Promise<NextResponse> {
  const config = getOfficialTelegramBotConfig();
  if (!config.botToken) {
    return NextResponse.json(
      {
        error: {
          message: "Official Telegram bot is not configured",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  if (body.telegramAuth) {
    return linkOfficialWithTelegramAuth(body, userId, orgId, config.botToken);
  }

  if (body.connectSignature) {
    return linkOfficialWithConnectSignature(
      body,
      userId,
      orgId,
      config.botToken,
    );
  }

  return missingAuthMethodResponse();
}

async function linkOfficialWithTelegramAuth(
  body: LinkBody,
  userId: string,
  orgId: string,
  botToken: string,
): Promise<NextResponse> {
  if (!body.telegramAuth) return missingAuthMethodResponse();

  if (!verifyTelegramLogin(body.telegramAuth, botToken)) {
    return invalidTelegramAuthResponse();
  }

  const composeId = await resolveOfficialConnectComposeId(userId, orgId);
  if (!composeId) {
    return missingOfficialAgentResponse();
  }

  const telegramUserId = String(body.telegramAuth.id);
  const conflictResponse = await linkOfficialUserOrConflict({
    telegramUserId,
    telegramUsername: body.telegramAuth.username,
    telegramDisplayName: formatTelegramUserDisplayName(body.telegramAuth),
    vm0UserId: userId,
    orgId,
  });
  if (conflictResponse) return conflictResponse;

  return NextResponse.json({
    botUsername: getOfficialTelegramBotConfig().botUsername ?? "Zero",
    telegramUserId,
  });
}

async function linkOfficialWithConnectSignature(
  body: LinkBody,
  userId: string,
  orgId: string,
  botToken: string,
): Promise<NextResponse> {
  const connectSignature = body.connectSignature;
  if (!connectSignature) return missingAuthMethodResponse();

  if (
    !verifyConnectSignature(
      OFFICIAL_TELEGRAM_BOT_ID,
      connectSignature.telegramUserId,
      connectSignature.timestamp,
      connectSignature.signature,
      botToken,
      connectSignature.telegramUsername,
      connectSignature.telegramDisplayName,
    )
  ) {
    return invalidConnectSignatureResponse();
  }

  const composeId = await resolveOfficialConnectComposeId(userId, orgId);
  if (!composeId) {
    return missingOfficialAgentResponse();
  }

  const telegramUserId = connectSignature.telegramUserId;
  const conflictResponse = await linkOfficialUserOrConflict({
    telegramUserId,
    telegramUsername: connectSignature.telegramUsername,
    telegramDisplayName: connectSignature.telegramDisplayName,
    vm0UserId: userId,
    orgId,
  });
  if (conflictResponse) return conflictResponse;

  const config = getOfficialTelegramBotConfig();
  const client = createTelegramClient(botToken);
  sendMessage(
    client,
    telegramUserId,
    formatTelegramCommandSuccess(
      "Account linked.\nSend me a message to start chatting with Zero.",
    ),
  ).catch((err) => {
    log.warn("Failed to send official connect success message", { err });
  });

  return NextResponse.json({
    botUsername: config.botUsername ?? "Zero",
    telegramUserId,
  });
}

async function handleCustomLinkPost(
  body: LinkBody,
  userId: string,
  orgId: string,
): Promise<NextResponse> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  // Look up installation
  const [installation] = await globalThis.services.db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      botUsername: telegramInstallations.botUsername,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
      orgId: telegramInstallations.orgId,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, body.telegramBotId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Installation not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }
  if (installation.orgId !== orgId) {
    return orgMismatchResponse();
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );

  // If telegramAuth is provided, verify and create a direct link
  if (body.telegramAuth) {
    return linkCustomWithTelegramAuth(body, userId, orgId, botToken, {
      telegramBotId: installation.telegramBotId,
      botUsername: installation.botUsername,
    });
  }

  // Connect via signed params from /connect command
  if (body.connectSignature) {
    return linkCustomWithConnectSignature(body, userId, orgId, botToken, {
      telegramBotId: installation.telegramBotId,
      botUsername: installation.botUsername,
    });
  }

  return missingAuthMethodResponse();
}

async function linkCustomWithTelegramAuth(
  body: LinkBody,
  userId: string,
  orgId: string,
  botToken: string,
  installation: { telegramBotId: string; botUsername: string | null },
): Promise<NextResponse> {
  if (!body.telegramAuth) return missingAuthMethodResponse();

  if (!verifyTelegramLogin(body.telegramAuth, botToken)) {
    return invalidTelegramAuthResponse();
  }

  const telegramUserId = String(body.telegramAuth.id);
  const conflictResponse = await linkUserOrConflict({
    installationId: installation.telegramBotId,
    telegramUserId,
    telegramUsername: body.telegramAuth.username,
    telegramDisplayName: formatTelegramUserDisplayName(body.telegramAuth),
    vm0UserId: userId,
    orgId,
  });
  if (conflictResponse) return conflictResponse;

  return NextResponse.json({
    botUsername: installation.botUsername ?? "Telegram bot",
    telegramUserId,
  });
}

async function linkCustomWithConnectSignature(
  body: LinkBody,
  userId: string,
  orgId: string,
  botToken: string,
  installation: { telegramBotId: string; botUsername: string | null },
): Promise<NextResponse> {
  const connectSignature = body.connectSignature;
  if (!connectSignature) return missingAuthMethodResponse();

  if (
    !verifyConnectSignature(
      body.telegramBotId,
      connectSignature.telegramUserId,
      connectSignature.timestamp,
      connectSignature.signature,
      botToken,
      connectSignature.telegramUsername,
      connectSignature.telegramDisplayName,
    )
  ) {
    return invalidConnectSignatureResponse();
  }

  const telegramUserId = connectSignature.telegramUserId;
  const conflictResponse = await linkUserOrConflict({
    installationId: installation.telegramBotId,
    telegramUserId,
    telegramUsername: connectSignature.telegramUsername,
    telegramDisplayName: connectSignature.telegramDisplayName,
    vm0UserId: userId,
    orgId,
  });
  if (conflictResponse) return conflictResponse;

  const client = createTelegramClient(botToken);
  sendMessage(
    client,
    telegramUserId,
    formatTelegramCommandSuccess(
      "Account linked.\nSend me a message to start chatting with your agent.",
    ),
  ).catch((err) => {
    log.warn("Failed to send connect success message", { err });
  });

  return NextResponse.json({
    botUsername: installation.botUsername ?? "Telegram bot",
    telegramUserId,
  });
}

function invalidTelegramAuthResponse() {
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

function invalidConnectSignatureResponse() {
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

function missingAuthMethodResponse() {
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
