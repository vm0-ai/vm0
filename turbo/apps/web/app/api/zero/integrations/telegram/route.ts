import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import {
  extractAndGroupVariables,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { telegramInstallations } from "../../../../../src/db/schema/telegram-installation";
import { telegramUserLinks } from "../../../../../src/db/schema/telegram-user-link";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { listSecrets } from "../../../../../src/lib/secret/secret-service";
import { listVariables } from "../../../../../src/lib/variable/variable-service";
import { listConnectors } from "../../../../../src/lib/connector/connector-service";
import {
  getOrgData,
  getOrgBySlug,
} from "../../../../../src/lib/org/org-cache-service";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { deleteWebhook } from "../../../../../src/lib/telegram/client";
import { checkTelegramDomain } from "../../../../../src/lib/telegram/check-domain";
import { resolveDefaultComposeId } from "../../../../../src/lib/slack-org/handlers/shared";
import type { AgentComposeYaml } from "../../../../../src/types/agent-compose";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:zero:telegram");

/**
 * GET /api/zero/integrations/telegram
 *
 * Returns org-scoped Telegram bot info for the authenticated user,
 * including bot details, connection status, and environment status.
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
  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org, member } = await resolveOrg(authCtx, orgSlug);
  const isAdmin = member.role === "admin";

  const db = globalThis.services.db;

  // Find the installation for this org
  const [installation] = await db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, org.orgId))
    .limit(1);

  // Check domain configuration for Telegram Login Widget
  const { NEXT_PUBLIC_APP_URL } = env();

  if (!installation) {
    // Check domain with a placeholder bot ID — domain config is per-domain, not per-bot
    // We can only fully check when a bot is installed
    return NextResponse.json({
      isConnected: false,
      isInstalled: false,
      isAdmin,
    });
  }

  // Find user's connection
  const [userLink] = await db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.vm0UserId, userId),
        eq(telegramUserLinks.installationId, installation.id),
      ),
    )
    .limit(1);

  const domainConfigured = await checkTelegramDomain(
    installation.telegramBotId,
    NEXT_PUBLIC_APP_URL,
  );

  if (!userLink) {
    return NextResponse.json({
      isConnected: false,
      isInstalled: true,
      isAdmin,
      enabled: installation.enabled,
      bot: {
        id: installation.telegramBotId,
        username: installation.botUsername,
      },
      domainConfigured,
    });
  }

  return getConnectedStatus(
    org.orgId,
    userId,
    member,
    installation,
    domainConfigured,
  );
}

const patchBodySchema = z.object({
  enabled: z.boolean().optional(),
  agentName: z.string().optional(),
});

/**
 * PATCH /api/zero/integrations/telegram
 *
 * Toggle enabled state and/or change default agent. Admin only.
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

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org, member } = await resolveOrg(authCtx, orgSlug);

  if (member.role !== "admin") {
    return NextResponse.json(
      { error: { message: "Admin access required", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  const parseResult = patchBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { message: "Invalid request body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  const db = globalThis.services.db;

  const [installation] = await db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, org.orgId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "No Telegram bot installed", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (body.enabled !== undefined) {
    updates.enabled = body.enabled;
  }

  if (body.agentName) {
    // Parse org/agentName format
    const slashIndex = body.agentName.indexOf("/");
    const agentName =
      slashIndex === -1 ? body.agentName : body.agentName.slice(slashIndex + 1);
    const agentOrgSlug =
      slashIndex === -1 ? null : body.agentName.slice(0, slashIndex);

    let targetOrgId: string;
    if (agentOrgSlug) {
      const resolved = await getOrgBySlug(agentOrgSlug);
      if (!resolved) {
        return NextResponse.json(
          { error: { message: "Org not found", code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
      targetOrgId = resolved.orgId;
    } else {
      targetOrgId = org.orgId;
    }

    const [compose] = await db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, targetOrgId),
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

    updates.defaultComposeId = compose.id;
  }

  await db
    .update(telegramInstallations)
    .set(updates)
    .where(eq(telegramInstallations.id, installation.id));

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/zero/integrations/telegram
 *
 * ?action=uninstall — Admin-only: removes the bot installation and all data.
 * (default)         — Disconnects the authenticated user's connection.
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

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const orgSlug = url.searchParams.get("org");

  if (action === "uninstall") {
    return handleUninstall(authCtx, orgSlug);
  }
  return handleDisconnect(authCtx, orgSlug);
}

async function handleUninstall(
  authCtx: { userId: string },
  orgSlug: string | null,
) {
  const { org, member } = await resolveOrg(authCtx, orgSlug);

  if (member.role !== "admin") {
    return NextResponse.json(
      { error: { message: "Admin access required", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  const { SECRETS_ENCRYPTION_KEY } = env();
  const db = globalThis.services.db;

  const [installation] = await db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, org.orgId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "No Telegram bot installed", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Remove webhook from Telegram (best-effort)
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

  log.info("Telegram bot uninstalled", {
    installationId: installation.id,
    orgId: org.orgId,
    uninstalledBy: authCtx.userId,
  });

  return NextResponse.json({ ok: true });
}

async function handleDisconnect(
  authCtx: { userId: string },
  orgSlug: string | null,
) {
  const { userId } = authCtx;
  const { org } = await resolveOrg(authCtx, orgSlug);
  const db = globalThis.services.db;

  // Find installation for this org
  const [installation] = await db
    .select({ id: telegramInstallations.id })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, org.orgId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "No Telegram bot installed", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  const deleted = await db
    .delete(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.vm0UserId, userId),
        eq(telegramUserLinks.installationId, installation.id),
      ),
    )
    .returning({ id: telegramUserLinks.id });

  if (deleted.length === 0) {
    return NextResponse.json(
      { error: { message: "No Telegram connection found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}

async function getConnectedStatus(
  orgId: string,
  userId: string,
  member: { role: string },
  installation: typeof telegramInstallations.$inferSelect,
  domainConfigured: boolean,
): Promise<NextResponse> {
  const db = globalThis.services.db;

  const composeId = await resolveDefaultComposeId(orgId);
  let defaultAgentName: string | null = null;
  let agentOrgSlug: string | null = null;

  let requiredSecrets: string[] = [];
  let requiredVars: string[] = [];

  if (composeId) {
    const [compose] = await db
      .select({
        name: agentComposes.name,
        orgId: agentComposes.orgId,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId))
      .limit(1);

    if (compose) {
      defaultAgentName = compose.name;
      agentOrgSlug = (await getOrgData(compose.orgId)).slug;

      if (compose.headVersionId) {
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
    }
  }

  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(orgId, userId),
    listVariables(orgId, userId),
    listConnectors(orgId, userId),
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

  return NextResponse.json({
    isConnected: true,
    isInstalled: true,
    isAdmin: member.role === "admin",
    enabled: installation.enabled,
    bot: {
      id: installation.telegramBotId,
      username: installation.botUsername,
    },
    defaultAgentName,
    agentOrgSlug,
    domainConfigured,
    environment: {
      requiredSecrets,
      requiredVars,
      missingSecrets,
      missingVars,
    },
  });
}
