import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { slackUserLinks } from "../../../../src/db/schema/slack-user-link";
import { slackInstallations } from "../../../../src/db/schema/slack-installation";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { listSecrets } from "../../../../src/lib/secret/secret-service";
import {
  getOrgData,
  getOrgBySlug,
} from "../../../../src/lib/scope/org-cache-service";
import { listVariables } from "../../../../src/lib/variable/variable-service";
import { listConnectors } from "../../../../src/lib/connector/connector-service";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";
import {
  createSlackClient,
  getSlackRedirectBaseUrl,
  refreshAppHome,
} from "../../../../src/lib/slack";
import { decryptSecretValue } from "../../../../src/lib/crypto/secrets-encryption";
import { removePermission } from "../../../../src/lib/agent/permission-service";
import { getUserEmail } from "../../../../src/lib/auth/get-user-email";
import { resolveScope } from "../../../../src/lib/scope/resolve-scope";
import { syncWorkspaceAgentPermissions } from "../../../../src/lib/slack/permission-sync";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:slack");

/**
 * GET /api/integrations/slack
 *
 * Returns Slack workspace info for the authenticated user,
 * including workspace name, current agent, and environment variable status.
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

  // Find user's most recent Slack link
  const [userLink] = await db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.vm0UserId, userId))
    .orderBy(desc(slackUserLinks.createdAt))
    .limit(1);

  if (!userLink) {
    const baseUrl = getSlackRedirectBaseUrl(request.url);
    const params = new URLSearchParams({ vm0UserId: userId });
    const installUrl = `${baseUrl}/api/slack/oauth/install?${params.toString()}`;
    return NextResponse.json(
      {
        error: { message: "No linked Slack workspace", code: "NOT_FOUND" },
        installUrl,
      },
      { status: 404 },
    );
  }

  // Get workspace installation
  const [installation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, userLink.slackWorkspaceId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Slack workspace not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Get workspace agent with scope info for navigation
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

  const scopeSlug = compose ? (await getOrgData(compose.orgId)).slug : null;

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
      requiredSecrets = grouped.secrets.map((s) => s.name);
      requiredVars = grouped.vars.map((v) => v.name);
    }
  }

  // Get user's existing secrets, vars, connectors
  const { scope } = await resolveScope(userId, null, null, tokenScopeId);
  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(scope.orgId, userId),
    listVariables(scope.orgId, userId),
    listConnectors(scope.orgId, userId),
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

  const isAdmin = userLink.slackUserId === installation.adminSlackUserId;

  return NextResponse.json({
    workspace: {
      id: installation.slackWorkspaceId,
      name: installation.slackWorkspaceName,
    },
    agent: compose ? { id: compose.id, name: compose.name, scopeSlug } : null,
    isAdmin,
    environment: {
      requiredSecrets,
      requiredVars,
      missingSecrets,
      missingVars,
    },
  });
}

/**
 * DELETE /api/integrations/slack
 *
 * Disconnects the authenticated user's Slack link.
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

  // Find user's most recent Slack link
  const [userLink] = await db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.vm0UserId, userId))
    .orderBy(desc(slackUserLinks.createdAt))
    .limit(1);

  if (!userLink) {
    return NextResponse.json(
      { error: { message: "No linked Slack workspace", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Get workspace installation for permission revocation and App Home refresh
  const [installation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, userLink.slackWorkspaceId))
    .limit(1);

  // Revoke agent permission
  if (installation) {
    const email = await getUserEmail(userId);
    if (email) {
      await removePermission(installation.defaultComposeId, "email", email);
    }
  }

  // Delete user link
  await db.delete(slackUserLinks).where(eq(slackUserLinks.id, userLink.id));

  // Refresh App Home to reflect disconnected state
  if (installation) {
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);
    await refreshAppHome(client, installation, userLink.slackUserId).catch(
      (error) => {
        log.warn("Failed to refresh App Home after disconnect", { error });
      },
    );
  }

  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/integrations/slack
 *
 * Updates the default agent for the authenticated user's Slack workspace.
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

  const body = (await request.json()) as { agentName?: string };
  if (!body.agentName) {
    return NextResponse.json(
      { error: { message: "agentName is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const db = globalThis.services.db;

  // Find user's most recent Slack link
  const [userLink] = await db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.vm0UserId, userId))
    .orderBy(desc(slackUserLinks.createdAt))
    .limit(1);

  if (!userLink) {
    return NextResponse.json(
      { error: { message: "No linked Slack workspace", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Get workspace installation
  const [installation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, userLink.slackWorkspaceId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Slack workspace not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Only workspace admin can change the default agent
  if (userLink.slackUserId !== installation.adminSlackUserId) {
    return NextResponse.json(
      {
        error: {
          message: "Only the workspace admin can change the default agent",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // Parse scope/agentName format (shared agents use "scopeSlug/agentName")
  const slashIndex = body.agentName.indexOf("/");
  const agentName =
    slashIndex === -1 ? body.agentName : body.agentName.slice(slashIndex + 1);
  const scopeSlug =
    slashIndex === -1 ? null : body.agentName.slice(0, slashIndex);

  // Resolve target scope (no membership check - admin can select any agent)
  let targetOrgId: string;
  if (scopeSlug) {
    const targetOrg = await getOrgBySlug(scopeSlug);
    if (!targetOrg) {
      return NextResponse.json(
        { error: { message: "Scope not found", code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
    targetOrgId = targetOrg.orgId;
  } else {
    const { scope } = await resolveScope(userId, null, null, tokenScopeId);
    targetOrgId = scope.orgId;
  }

  // Find agent compose by name in target scope
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

  const oldComposeId = installation.defaultComposeId;

  // Update installation + sync permissions atomically
  await db.transaction(async (tx) => {
    await tx
      .update(slackInstallations)
      .set({ defaultComposeId: compose.id, updatedAt: new Date() })
      .where(eq(slackInstallations.id, installation.id));

    await syncWorkspaceAgentPermissions(
      oldComposeId,
      compose.id,
      installation.slackWorkspaceId,
      installation.adminSlackUserId,
      tx,
    );
  });

  return NextResponse.json({ ok: true });
}
