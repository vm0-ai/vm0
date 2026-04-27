import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import {
  ensureOrgAndArtifact,
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

const log = logger("api:telegram:link");

type LinkTelegramUserConflictReason = Extract<
  LinkTelegramUserResult,
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

async function linkUserOrConflict(params: {
  installationId: string;
  telegramUserId: string;
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

  return new NextResponse(null, { status: 204 });
}

const connectSignatureSchema = z.object({
  telegramUserId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
});

const linkBodySchema = z.object({
  telegramBotId: z.string().min(1),
  telegramAuth: telegramAuthSchema.optional(),
  connectSignature: connectSignatureSchema.optional(),
});

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
  if (installation.orgId !== org.orgId) {
    return orgMismatchResponse();
  }

  // If telegramAuth is provided, verify and create a direct link
  if (body.telegramAuth) {
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );

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

    const conflictResponse = await linkUserOrConflict({
      installationId: installation.telegramBotId,
      telegramUserId,
      vm0UserId: userId,
      orgId: org.orgId,
    });
    if (conflictResponse) return conflictResponse;

    return NextResponse.json({
      botUsername: installation.botUsername,
      telegramUserId,
    });
  }

  // Connect via signed params from /connect command
  if (body.connectSignature) {
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );

    if (
      !verifyConnectSignature(
        body.telegramBotId,
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

    const conflictResponse = await linkUserOrConflict({
      installationId: installation.telegramBotId,
      telegramUserId,
      vm0UserId: userId,
      orgId: org.orgId,
    });
    if (conflictResponse) return conflictResponse;

    // Send success message to user in Telegram (non-blocking)
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
      botUsername: installation.botUsername,
      telegramUserId,
    });
  }

  // No auth method provided
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
