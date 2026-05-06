import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { OFFICIAL_TELEGRAM_BOT_ID } from "../../../../../src/lib/zero/telegram/official";
import { setTelegramUserAgentPreference } from "../../../../../src/lib/zero/telegram/official-user";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import { logger } from "../../../../../src/lib/shared/logger";
import { deleteWebhook } from "../../../../../src/lib/zero/telegram/client";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  buildOfficialTelegramBot,
  buildTelegramBotStatus,
  type TelegramInstallation,
} from "../telegram-status";
import {
  publishTelegramOrgChangedSafely,
  publishTelegramUserChangedSafely,
} from "../../../../../src/lib/zero/telegram/realtime";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";

const patchBodySchema = z.object({
  defaultAgentId: z.string().trim().min(1).optional(),
  selectedAgentId: z.string().trim().min(1).nullable().optional(),
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

async function isOfficialTelegramEnabled(params: {
  orgId: string;
  userId: string;
}): Promise<boolean> {
  const overrides = await loadFeatureSwitchOverrides(
    params.orgId,
    params.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.OfficialTelegramBot, {
    orgId: params.orgId,
    userId: params.userId,
    overrides,
  });
}

async function loadComposeInOrg(composeId: string, orgId: string) {
  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id, orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) {
    return null;
  }
  if (compose.orgId !== orgId) {
    return "forbidden" as const;
  }
  return compose;
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

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    if (
      !(await isOfficialTelegramEnabled({
        orgId: org.orgId,
        userId: authCtx.userId,
      }))
    ) {
      return notFoundResponse();
    }

    return NextResponse.json(
      await buildOfficialTelegramBot({
        orgId: org.orgId,
        userId: authCtx.userId,
      }),
    );
  }

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

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    if (
      !(await isOfficialTelegramEnabled({
        orgId: org.orgId,
        userId: authCtx.userId,
      }))
    ) {
      return notFoundResponse();
    }

    const parseResult = patchBodySchema.safeParse(await request.json());
    if (!parseResult.success || !("selectedAgentId" in parseResult.data)) {
      return NextResponse.json(
        {
          error: {
            message: "selectedAgentId is required",
            code: "BAD_REQUEST",
          },
        },
        { status: 400 },
      );
    }

    const selectedAgentId = parseResult.data.selectedAgentId ?? null;
    if (selectedAgentId) {
      const compose = await loadComposeInOrg(selectedAgentId, org.orgId);
      if (!compose) {
        return NextResponse.json(
          { error: { message: "Agent not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }
      if (compose === "forbidden") {
        return forbiddenResponse(
          "Telegram official bot preferences can only use agents in the active organization",
        );
      }
    }

    await setTelegramUserAgentPreference({
      vm0UserId: authCtx.userId,
      orgId: org.orgId,
      composeId: selectedAgentId,
    });
    await publishTelegramUserChangedSafely(authCtx.userId);

    return NextResponse.json(
      await buildOfficialTelegramBot({
        orgId: org.orgId,
        userId: authCtx.userId,
      }),
    );
  }

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
  if (!parseResult.success || !parseResult.data.defaultAgentId) {
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

  await publishTelegramOrgChangedSafely(visible.installation.orgId);

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

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    return forbiddenResponse("The official Telegram bot cannot be uninstalled");
  }

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

  await publishTelegramOrgChangedSafely(visible.installation.orgId);

  return new NextResponse(null, { status: 204 });
}
