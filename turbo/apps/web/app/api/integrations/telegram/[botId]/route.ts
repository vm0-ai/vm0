import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import { logger } from "../../../../../src/lib/shared/logger";
import { deleteWebhook } from "../../../../../src/lib/zero/telegram/client";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  buildTelegramBotStatus,
  type TelegramInstallation,
} from "../telegram-status";

const patchBodySchema = z.object({
  defaultAgentId: z.string().trim().min(1),
});

const log = logger("api:telegram:integration-bot");

function unauthorizedResponse() {
  return NextResponse.json(
    { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
    { status: 401 },
  );
}

function notFoundResponse() {
  return NextResponse.json(
    { error: { message: "Telegram bot not found", code: "NOT_FOUND" } },
    { status: 404 },
  );
}

function forbiddenResponse(message: string) {
  return NextResponse.json(
    {
      error: {
        message,
        code: "FORBIDDEN",
      },
    },
    { status: 403 },
  );
}

async function loadVisibleInstallation(params: {
  botId: string;
  orgId: string;
  userId: string;
}): Promise<{
  installation: TelegramInstallation;
  isOwner: boolean;
} | null> {
  const [installation] = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, params.botId))
    .limit(1);

  if (!installation || installation.orgId !== params.orgId) {
    return null;
  }

  const isOwner = installation.ownerUserId === params.userId;
  return { installation, isOwner };
}

/**
 * GET /api/integrations/telegram/[botId]
 *
 * Returns full status for a Telegram bot in the active org.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ botId: string }> },
) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);

  if (!authCtx) {
    return unauthorizedResponse();
  }

  const { botId } = await params;
  const { org } = await resolveOrg(authCtx);
  const visible = await loadVisibleInstallation({
    botId,
    orgId: org.orgId,
    userId: authCtx.userId,
  });

  if (!visible) {
    return notFoundResponse();
  }

  return NextResponse.json(
    await buildTelegramBotStatus(visible.installation, authCtx.userId),
  );
}

/**
 * PATCH /api/integrations/telegram/[botId]
 *
 * Owner/admin update for the bot default agent.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ botId: string }> },
) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);

  if (!authCtx) {
    return unauthorizedResponse();
  }

  const { botId } = await params;
  const { org, member } = await resolveOrg(authCtx);
  const visible = await loadVisibleInstallation({
    botId,
    orgId: org.orgId,
    userId: authCtx.userId,
  });

  if (!visible) {
    return notFoundResponse();
  }

  if (!visible.isOwner && member.role !== "admin") {
    return forbiddenResponse(
      "Only the bot owner or an org admin can change the default agent",
    );
  }

  const parseResult = patchBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { message: "defaultAgentId is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id, orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, parseResult.data.defaultAgentId))
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Agent not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }
  if (compose.orgId !== visible.installation.orgId) {
    return forbiddenResponse(
      "Telegram bots can only be connected to agents in the bot's organization",
    );
  }

  const [updated] = await globalThis.services.db
    .update(telegramInstallations)
    .set({ defaultComposeId: compose.id, updatedAt: new Date() })
    .where(
      eq(
        telegramInstallations.telegramBotId,
        visible.installation.telegramBotId,
      ),
    )
    .returning();

  return NextResponse.json(
    await buildTelegramBotStatus(
      updated ?? visible.installation,
      authCtx.userId,
    ),
  );
}

/**
 * DELETE /api/integrations/telegram/[botId]
 *
 * Owner/admin uninstall. Removes webhook best-effort, then deletes installation.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ botId: string }> },
) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);

  if (!authCtx) {
    return unauthorizedResponse();
  }

  const { botId } = await params;
  const { org, member } = await resolveOrg(authCtx);
  const visible = await loadVisibleInstallation({
    botId,
    orgId: org.orgId,
    userId: authCtx.userId,
  });

  if (!visible) {
    return notFoundResponse();
  }

  if (!visible.isOwner && member.role !== "admin") {
    return forbiddenResponse(
      "Only the bot owner or an org admin can uninstall this bot",
    );
  }

  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    visible.installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  await deleteWebhook(botToken).catch((error) => {
    log.warn("Failed to remove Telegram webhook", { error });
  });

  await globalThis.services.db
    .delete(telegramInstallations)
    .where(
      eq(
        telegramInstallations.telegramBotId,
        visible.installation.telegramBotId,
      ),
    );

  return new NextResponse(null, { status: 204 });
}
