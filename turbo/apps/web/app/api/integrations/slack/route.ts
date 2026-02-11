import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { slackUserLinks } from "../../../../src/db/schema/slack-user-link";
import { slackInstallations } from "../../../../src/db/schema/slack-installation";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { listSecrets } from "../../../../src/lib/secret/secret-service";
import { listVariables } from "../../../../src/lib/variable/variable-service";
import { listConnectors } from "../../../../src/lib/connector/connector-service";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";
import {
  createSlackClient,
  getSlackRedirectBaseUrl,
  refreshAppHome,
} from "../../../../src/lib/slack";
import { decryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import { removePermission } from "../../../../src/lib/agent/permission-service";
import { getUserEmail } from "../../../../src/lib/auth/get-user-email";
import { getUserScopeByClerkId } from "../../../../src/lib/scope/scope-service";

/**
 * GET /api/integrations/slack
 *
 * Returns Slack workspace info for the authenticated user,
 * including workspace name, current agent, and environment variable status.
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const db = globalThis.services.db;

  // Find user's Slack link
  const [userLink] = await db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.vm0UserId, userId))
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

  // Get workspace agent
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
      const refs = extractVariableReferences(content);
      const grouped = groupVariablesBySource(refs);
      requiredSecrets = [
        ...grouped.secrets.map((s) => s.name),
        ...grouped.credentials.map((s) => s.name),
      ];
      requiredVars = grouped.vars.map((v) => v.name);
    }
  }

  // Get user's existing secrets, vars, connectors
  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(userId),
    listVariables(userId),
    listConnectors(userId),
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
    agent: compose ? { id: compose.id, name: compose.name } : null,
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
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { SECRETS_ENCRYPTION_KEY } = env();
  const db = globalThis.services.db;

  // Find user's Slack link
  const [userLink] = await db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.vm0UserId, userId))
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
    const botToken = decryptCredentialValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);
    await refreshAppHome(client, installation, userLink.slackUserId).catch(
      () => {},
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
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const body = (await request.json()) as { agentName?: string };
  if (!body.agentName) {
    return NextResponse.json(
      { error: { message: "agentName is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const db = globalThis.services.db;

  // Find user's Slack link
  const [userLink] = await db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.vm0UserId, userId))
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

  // Resolve user's scope to find the agent compose
  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    return NextResponse.json(
      { error: { message: "User scope not found", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  // Find agent compose by name in user's scope
  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.scopeId, userScope.id),
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

  // Update the installation's default compose
  await db
    .update(slackInstallations)
    .set({ defaultComposeId: compose.id, updatedAt: new Date() })
    .where(eq(slackInstallations.id, installation.id));

  return NextResponse.json({ ok: true });
}
