import { NextResponse } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import {
  extractAndGroupVariables,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { telegramUserLinks } from "../../../../src/db/schema/telegram-user-link";
import { telegramInstallations } from "../../../../src/db/schema/telegram-installation";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { listSecrets } from "../../../../src/lib/secret/secret-service";
import {
  getOrgData,
  getOrgBySlug,
} from "../../../../src/lib/org/org-cache-service";
import { listVariables } from "../../../../src/lib/variable/variable-service";
import { listConnectors } from "../../../../src/lib/connector/connector-service";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";
import { decryptSecretValue } from "../../../../src/lib/crypto/secrets-encryption";
import { deleteWebhook } from "../../../../src/lib/telegram/client";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { isNotFound } from "../../../../src/lib/errors";
import { logger } from "../../../../src/lib/logger";
import { checkTelegramDomain } from "../../../../src/lib/telegram/check-domain";

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
  const { userId, orgId: tokenOrgId } = authCtx;

  const db = globalThis.services.db;

  // Find user's most recent Telegram link
  const [userLink] = await db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.vm0UserId, userId))
    .orderBy(desc(telegramUserLinks.createdAt))
    .limit(1);

  // Find installation via user link or admin ownership
  let installation;
  if (userLink) {
    [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.id, userLink.installationId))
      .limit(1);
  } else {
    [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.adminUserId, userId))
      .limit(1);
  }

  if (!installation) {
    return NextResponse.json(
      { error: { message: "No linked Telegram bot", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Get default agent with org info
  const [compose] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      orgId: agentComposes.orgId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  const orgSlug = compose ? (await getOrgData(compose.orgId)).slug : null;

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
      requiredSecrets = grouped.secrets.map((s) => s.name);
      requiredVars = grouped.vars.map((v) => v.name);
    }
  }

  // Resolve user's default org and get existing secrets, vars, connectors
  const { org } = await resolveOrg(userId, null, null, tokenOrgId);
  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(org.orgId, userId),
    listVariables(org.orgId, userId),
    listConnectors(org.orgId, userId),
  ]);

  const connectorProvided = getConnectorProvidedSecretNames(
    userConnectors.map((c) => c.type),
  );
  const existingSecretNames = new Set([
    ...userSecrets.map((s) => s.name),
    ...connectorProvided,
  ]);
  const existingVarNames = new Set(userVars.map((v) => v.name));

  const missingSecrets = requiredSecrets.filter(
    (name) => !existingSecretNames.has(name),
  );
  const missingVars = requiredVars.filter(
    (name) => !existingVarNames.has(name),
  );

  const isAdmin = installation.adminUserId === userId;
  const isConnected = !!userLink;

  const { NEXT_PUBLIC_PLATFORM_URL } = env();
  const domainConfigured = await checkTelegramDomain(
    installation.telegramBotId,
    NEXT_PUBLIC_PLATFORM_URL,
  );

  return NextResponse.json({
    installationId: installation.id,
    bot: {
      id: installation.telegramBotId,
      username: installation.botUsername,
    },
    agent: compose ? { id: compose.id, name: compose.name, orgSlug } : null,
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
  const { userId, orgId: tokenOrgId } = authCtx;

  const parseResult = patchBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { message: "agentName is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  const db = globalThis.services.db;

  // Find user's Telegram link
  const [userLink] = await db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.vm0UserId, userId))
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
    .where(eq(telegramInstallations.id, userLink.installationId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Telegram bot not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Admin check
  if (installation.adminUserId !== userId) {
    return NextResponse.json(
      {
        error: {
          message: "Only the bot admin can change the default agent",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // Parse org/agentName format
  const slashIndex = body.agentName.indexOf("/");
  const agentName =
    slashIndex === -1 ? body.agentName : body.agentName.slice(slashIndex + 1);
  const orgSlug =
    slashIndex === -1 ? null : body.agentName.slice(0, slashIndex);

  // Resolve target org
  let targetOrg: { orgId: string };
  if (orgSlug) {
    const resolved = await getOrgBySlug(orgSlug);
    if (!resolved) {
      return NextResponse.json(
        { error: { message: "Org not found", code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
    targetOrg = resolved;
  } else {
    try {
      ({ org: targetOrg } = await resolveOrg(userId, null, null, tokenOrgId));
    } catch (error) {
      if (isNotFound(error)) {
        return NextResponse.json(
          { error: { message: "No org configured", code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
      throw error;
    }
  }

  // Find agent
  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, targetOrg.orgId),
        eq(agentComposes.name, agentName),
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
    .where(eq(telegramInstallations.id, installation.id));

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

  const { SECRETS_ENCRYPTION_KEY } = env();
  const db = globalThis.services.db;

  // Find installation where user is admin
  const [installation] = await db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.adminUserId, userId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      {
        error: {
          message: "No Telegram bot found or you are not the bot admin",
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
    .where(eq(telegramInstallations.id, installation.id));

  return new NextResponse(null, { status: 204 });
}
