import { NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import {
  extractAndGroupVariables,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../../src/db/schema/slack-org-connection";
import { slackOrgPendingQuestions } from "../../../../../src/db/schema/slack-org-pending-question";
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
import { getOrgData } from "../../../../../src/lib/org/org-cache-service";
import {
  createSlackClient,
  getSlackRedirectBaseUrl,
} from "../../../../../src/lib/slack";
import { publishAppHome } from "../../../../../src/lib/slack/client";
import { buildAppHomeView } from "../../../../../src/lib/slack/blocks";
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

  const { userId } = authCtx;
  const { org, member } = await resolveOrg(userId);

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
    // Check if a workspace is installed for this org
    const [installation] = await db
      .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, org.orgId))
      .limit(1);

    const isAdmin = member.role === "admin";
    const { SLACK_CLIENT_ID } = env();
    const baseUrl = SLACK_CLIENT_ID
      ? getSlackRedirectBaseUrl(request.url)
      : null;

    // Build install URL for admins when no workspace is installed
    let installUrl: string | null = null;
    if (isAdmin && !installation && baseUrl) {
      const url = new URL(`${baseUrl}/api/slack/org/oauth/install`);
      url.searchParams.set("orgId", org.orgId);
      url.searchParams.set("vm0UserId", userId);
      installUrl = url.toString();
    }

    // Build connect URL when workspace is installed but user not connected
    let connectUrl: string | null = null;
    if (installation && baseUrl) {
      const url = new URL(`${baseUrl}/api/slack/org/oauth/connect`);
      url.searchParams.set("orgId", org.orgId);
      url.searchParams.set("vm0UserId", userId);
      connectUrl = url.toString();
    }

    return NextResponse.json({
      isConnected: false,
      isInstalled: !!installation,
      isAdmin,
      installUrl,
      connectUrl,
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
    defaultAgentName = agent?.displayName ?? agent?.name ?? null;

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
 * ?action=uninstall — Admin-only: removes the workspace installation and all connections.
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

  if (action === "uninstall") {
    return handleUninstall(authCtx);
  }
  return handleDisconnect(authCtx);
}

async function handleUninstall(authCtx: { userId: string }) {
  const { userId } = authCtx;
  const { org, member } = await resolveOrg(userId);

  if (member.role !== "admin") {
    return NextResponse.json(
      { error: { message: "Admin access required", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  const db = globalThis.services.db;

  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, org.orgId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      {
        error: {
          message: "No Slack installation found",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  // Refresh App Home for all connected users before deleting (best-effort)
  const connections = await db
    .select({
      id: slackOrgConnections.id,
      slackUserId: slackOrgConnections.slackUserId,
    })
    .from(slackOrgConnections)
    .where(
      eq(slackOrgConnections.slackWorkspaceId, installation.slackWorkspaceId),
    );

  if (connections.length > 0) {
    const { SECRETS_ENCRYPTION_KEY } = env();
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);

    // Publish an unlinked App Home for each connected user
    await Promise.allSettled(
      connections.map((c) =>
        publishAppHome(
          client,
          c.slackUserId,
          buildAppHomeView({ isLinked: false, isInstalled: false }),
        ),
      ),
    );

    // Delete pending questions
    const connectionIds = connections.map((c) => c.id);
    await db
      .delete(slackOrgPendingQuestions)
      .where(inArray(slackOrgPendingQuestions.connectionId, connectionIds));
  }

  // Delete all connections (cascades to thread sessions)
  await db
    .delete(slackOrgConnections)
    .where(
      eq(slackOrgConnections.slackWorkspaceId, installation.slackWorkspaceId),
    );

  // Delete the installation
  await db
    .delete(slackOrgInstallations)
    .where(
      eq(slackOrgInstallations.slackWorkspaceId, installation.slackWorkspaceId),
    );

  log.info("Slack workspace uninstalled", {
    workspaceId: installation.slackWorkspaceId,
    orgId: org.orgId,
    uninstalledBy: authCtx.userId,
  });

  return NextResponse.json({ ok: true });
}

async function handleDisconnect(authCtx: { userId: string }) {
  const { userId } = authCtx;
  const { org } = await resolveOrg(userId);
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

  // Delete connection record
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.id, connection.id));

  // Refresh App Home (best-effort)
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
