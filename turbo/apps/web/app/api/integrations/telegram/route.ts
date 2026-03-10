import { NextResponse } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import {
  extractVariableReferences,
  groupVariablesBySource,
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
import { scopes } from "../../../../src/db/schema/scope";
import { listSecrets } from "../../../../src/lib/secret/secret-service";
import { listVariables } from "../../../../src/lib/variable/variable-service";
import { listConnectors } from "../../../../src/lib/connector/connector-service";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";
import { decryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import { deleteWebhook } from "../../../../src/lib/telegram/client";
import { getScopeBySlug } from "../../../../src/lib/scope/scope-service";
import { resolveScope } from "../../../../src/lib/scope/resolve-scope";
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
  const { userId, scopeId: tokenScopeId } = authCtx;

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

  // Get default agent with scope info
  const [compose] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      scopeSlug: scopes.slug,
    })
    .from(agentComposes)
    .innerJoin(scopes, eq(scopes.clerkOrgId, agentComposes.clerkOrgId))
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
      const refs = extractVariableReferences(content);
      const grouped = groupVariablesBySource(refs);
      requiredSecrets = [
        ...grouped.secrets.map((s) => s.name),
        ...grouped.credentials.map((s) => s.name),
      ];
      requiredVars = grouped.vars.map((v) => v.name);
    }
  }

  // Resolve user's default scope and get existing secrets, vars, connectors
  const { scope } = await resolveScope(userId, null, null, tokenScopeId);
  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(scope.clerkOrgId, userId),
    listVariables(scope.clerkOrgId, userId),
    listConnectors(scope.clerkOrgId, userId),
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
    agent: compose
      ? { id: compose.id, name: compose.name, scopeSlug: compose.scopeSlug }
      : null,
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
  const { userId, scopeId: tokenScopeId } = authCtx;

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

  // Parse scope/agentName format
  const slashIndex = body.agentName.indexOf("/");
  const agentName =
    slashIndex === -1 ? body.agentName : body.agentName.slice(slashIndex + 1);
  const scopeSlug =
    slashIndex === -1 ? null : body.agentName.slice(0, slashIndex);

  // Resolve target scope
  let targetScope;
  if (scopeSlug) {
    targetScope = await getScopeBySlug(scopeSlug);
    if (!targetScope) {
      return NextResponse.json(
        { error: { message: "Scope not found", code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
  } else {
    try {
      ({ scope: targetScope } = await resolveScope(
        userId,
        null,
        null,
        tokenScopeId,
      ));
    } catch (error) {
      if (isNotFound(error)) {
        return NextResponse.json(
          { error: { message: "No scope configured", code: "BAD_REQUEST" } },
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
        eq(agentComposes.clerkOrgId, targetScope.clerkOrgId),
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
  const botToken = decryptCredentialValue(
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
