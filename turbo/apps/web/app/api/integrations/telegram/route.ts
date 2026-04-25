import { NextResponse } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import { getConnectorProvidedSecretNames } from "@vm0/api-contracts/contracts/connector-utils";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { listSecrets } from "../../../../src/lib/zero/secret/secret-service";
import { listVariables } from "../../../../src/lib/zero/variable/variable-service";
import { listConnectors } from "../../../../src/lib/zero/connector/connector-service";
import type { AgentComposeYaml } from "../../../../src/lib/infra/agent-compose/types";
import { decryptSecretValue } from "../../../../src/lib/shared/crypto/secrets-encryption";
import { deleteWebhook } from "../../../../src/lib/zero/telegram/client";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { logger } from "../../../../src/lib/shared/logger";
import { checkTelegramDomain } from "../../../../src/lib/zero/telegram/check-domain";

const patchBodySchema = z.object({
  agentName: z.string().min(1),
});

const log = logger("api:telegram:integration");

/**
 * GET /api/integrations/telegram
 *
 * Returns Telegram bot info for the authenticated user,
 * including bot details, current agent, and environment variable status.
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
  const { userId } = authCtx;
  const { org } = await resolveOrg(authCtx);

  const db = globalThis.services.db;

  // Find user's most recent Telegram link in the active org.
  const [userLink] = await db
    .select({
      id: telegramUserLinks.id,
      telegramUserId: telegramUserLinks.telegramUserId,
      installationId: telegramUserLinks.installationId,
      vm0UserId: telegramUserLinks.vm0UserId,
      dmWelcomeSent: telegramUserLinks.dmWelcomeSent,
      createdAt: telegramUserLinks.createdAt,
      updatedAt: telegramUserLinks.updatedAt,
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
      ),
    )
    .orderBy(desc(telegramUserLinks.createdAt))
    .limit(1);

  // Find installation via user link or owner ownership
  let installation;
  if (userLink) {
    [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, userLink.installationId))
      .limit(1);
  } else {
    [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(
        and(
          eq(telegramInstallations.ownerUserId, userId),
          eq(telegramInstallations.orgId, org.orgId),
        ),
      )
      .limit(1);
  }

  if (!installation) {
    return NextResponse.json(
      { error: { message: "No linked Telegram bot", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Get default agent
  const [compose] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  // Extract required secrets/vars from agent compose
  let requiredSecrets: string[] = [];
  let requiredVars: string[] = [];

  if (compose?.headVersionId) {
    const [version] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (version) {
      const content = version.content as AgentComposeYaml;
      const grouped = extractAndGroupVariables(content);
      requiredSecrets = grouped.secrets.map((s) => {
        return s.name;
      });
      requiredVars = grouped.vars.map((v) => {
        return v.name;
      });
    }
  }

  // Get existing secrets, vars, connectors from the active org.
  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(org.orgId, userId),
    listVariables(org.orgId, userId),
    listConnectors(org.orgId, userId),
  ]);

  const connectorProvided = getConnectorProvidedSecretNames(
    userConnectors.map((c) => {
      return c.type;
    }),
  );
  const existingSecretNames = new Set([
    ...userSecrets.map((s) => {
      return s.name;
    }),
    ...connectorProvided,
  ]);
  const existingVarNames = new Set(
    userVars.map((v) => {
      return v.name;
    }),
  );

  const missingSecrets = requiredSecrets.filter((name) => {
    return !existingSecretNames.has(name);
  });
  const missingVars = requiredVars.filter((name) => {
    return !existingVarNames.has(name);
  });

  const isAdmin = installation.ownerUserId === userId;
  const isConnected = !!userLink;

  const { NEXT_PUBLIC_APP_URL } = env();
  const domainConfigured = await checkTelegramDomain(
    installation.telegramBotId,
    NEXT_PUBLIC_APP_URL,
  );

  return NextResponse.json({
    installationId: installation.telegramBotId,
    bot: {
      id: installation.telegramBotId,
      username: installation.botUsername,
    },
    agent: compose ? { id: compose.id, name: compose.name } : null,
    isAdmin,
    isConnected,
    domainConfigured,
    environment: {
      requiredSecrets,
      requiredVars,
      missingSecrets,
      missingVars,
    },
  });
}

/**
 * PATCH /api/integrations/telegram
 *
 * Update the default agent for the Telegram bot.
 * Admin only.
 * Body: { agentName: string }
 */
export async function PATCH(request: Request) {
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
  const { org: targetOrg } = await resolveOrg(authCtx);

  const parseResult = patchBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { message: "agentName is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  const db = globalThis.services.db;

  // Find user's Telegram link in the active org.
  const [userLink] = await db
    .select({
      id: telegramUserLinks.id,
      telegramUserId: telegramUserLinks.telegramUserId,
      installationId: telegramUserLinks.installationId,
      vm0UserId: telegramUserLinks.vm0UserId,
      dmWelcomeSent: telegramUserLinks.dmWelcomeSent,
      createdAt: telegramUserLinks.createdAt,
      updatedAt: telegramUserLinks.updatedAt,
    })
    .from(telegramUserLinks)
    .innerJoin(
      telegramInstallations,
      eq(telegramUserLinks.installationId, telegramInstallations.telegramBotId),
    )
    .where(
      and(
        eq(telegramUserLinks.vm0UserId, userId),
        eq(telegramInstallations.orgId, targetOrg.orgId),
      ),
    )
    .orderBy(desc(telegramUserLinks.createdAt))
    .limit(1);

  if (!userLink) {
    return NextResponse.json(
      { error: { message: "No linked Telegram bot", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Get installation
  const [installation] = await db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, userLink.installationId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Telegram bot not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Owner check
  if (installation.ownerUserId !== userId) {
    return NextResponse.json(
      {
        error: {
          message: "Only the bot owner can change the default agent",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // Find agent
  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, targetOrg.orgId),
        eq(agentComposes.name, body.agentName),
      ),
    )
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Agent not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Update default agent
  await db
    .update(telegramInstallations)
    .set({ defaultComposeId: compose.id, updatedAt: new Date() })
    .where(eq(telegramInstallations.telegramBotId, installation.telegramBotId));

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/integrations/telegram
 *
 * Uninstall the Telegram bot. Admin only.
 * Removes webhook from Telegram and deletes the installation (cascades to user_links, sessions, messages).
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
  const { userId } = authCtx;
  const { org } = await resolveOrg(authCtx);

  const { SECRETS_ENCRYPTION_KEY } = env();
  const db = globalThis.services.db;

  // Find installation where user is owner
  const [installation] = await db
    .select()
    .from(telegramInstallations)
    .where(
      and(
        eq(telegramInstallations.ownerUserId, userId),
        eq(telegramInstallations.orgId, org.orgId),
      ),
    )
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      {
        error: {
          message: "No Telegram bot found or you are not the bot owner",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  // Remove webhook from Telegram (non-blocking on failure)
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  await deleteWebhook(botToken).catch((error) => {
    log.warn("Failed to remove Telegram webhook", { error });
  });

  // Delete installation (cascades to user_links, thread_sessions, messages)
  await db
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installation.telegramBotId));

  return new NextResponse(null, { status: 204 });
}
