import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import {
  extractAndGroupVariables,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../../src/lib/auth/get-user-email";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../../src/db/schema/slack-org-connection";
import {
  resolveDefaultComposeId,
  getWorkspaceAgent,
} from "../../../../../src/lib/slack-org/handlers/shared";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { listSecrets } from "../../../../../src/lib/secret/secret-service";
import { listVariables } from "../../../../../src/lib/variable/variable-service";
import { listConnectors } from "../../../../../src/lib/connector/connector-service";
import { removePermission } from "../../../../../src/lib/agent/permission-service";
import { getOrgData } from "../../../../../src/lib/org/org-cache-service";
import { createSlackClient } from "../../../../../src/lib/slack";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { refreshOrgAppHome } from "../../../../../src/lib/slack-org/handlers/app-home";
import type { AgentComposeYaml } from "../../../../../src/types/agent-compose";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:slack-org");

/**
 * GET /api/integrations/slack/org
 *
 * Returns org-scoped Slack workspace info for the authenticated user,
 * including workspace name, default agent, connection status, and environment status.
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
  const { org, member } = await resolveOrg(userId, null, null, tokenOrgId);

  const db = globalThis.services.db;

  // Find user's connection in any workspace bound to this org
  const [connection] = await db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, userId),
        eq(slackOrgConnections.orgId, org.orgId),
      ),
    )
    .limit(1);

  if (!connection) {
    return NextResponse.json({
      isConnected: false,
      isAdmin: member.role === "admin",
    });
  }

  // Get workspace info
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(
      eq(slackOrgInstallations.slackWorkspaceId, connection.slackWorkspaceId),
    )
    .limit(1);

  // Get default agent info
  const composeId = await resolveDefaultComposeId(org.orgId);
  let defaultAgentName: string | null = null;
  let agentOrgSlug: string | null = null;

  // Extract required secrets/vars from agent compose
  let requiredSecrets: string[] = [];
  let requiredVars: string[] = [];

  if (composeId) {
    const agent = await getWorkspaceAgent(composeId);
    defaultAgentName = agent?.name ?? null;

    // Get agent compose details for org slug and environment info
    const [compose] = await db
      .select({
        orgId: agentComposes.orgId,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId))
      .limit(1);

    if (compose) {
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

  // Get user's existing secrets, vars, connectors
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

  return NextResponse.json({
    isConnected: true,
    workspaceName: installation?.slackWorkspaceName ?? null,
    isAdmin: member.role === "admin",
    defaultAgentName,
    agentOrgSlug,
    environment: {
      requiredSecrets,
      requiredVars,
      missingSecrets,
      missingVars,
    },
  });
}

/**
 * DELETE /api/integrations/slack/org
 *
 * Disconnects the authenticated user's org-aware Slack connection.
 * Deletes the connection record, revokes agent permission, and refreshes App Home.
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

  const { userId, orgId: tokenOrgId } = authCtx;
  const { org } = await resolveOrg(userId, null, null, tokenOrgId);
  const { SECRETS_ENCRYPTION_KEY } = env();
  const db = globalThis.services.db;

  // Find user's connection
  const [connection] = await db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, userId),
        eq(slackOrgConnections.orgId, org.orgId),
      ),
    )
    .limit(1);

  if (!connection) {
    return NextResponse.json(
      { error: { message: "No Slack connection found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Revoke agent permission
  const composeId = await resolveDefaultComposeId(org.orgId);
  if (composeId) {
    const email = await getUserEmail(userId);
    if (email) {
      await removePermission(composeId, "email", email).catch((error) => {
        log.warn("Failed to revoke agent permission on disconnect", { error });
      });
    }
  }

  // Delete connection record
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.id, connection.id));

  // Refresh App Home to reflect disconnected state
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(
      eq(slackOrgInstallations.slackWorkspaceId, connection.slackWorkspaceId),
    )
    .limit(1);

  if (installation) {
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);
    await refreshOrgAppHome(client, installation, connection.slackUserId).catch(
      (error) => {
        log.warn("Failed to refresh App Home after disconnect", { error });
      },
    );
  }

  return NextResponse.json({ ok: true });
}
