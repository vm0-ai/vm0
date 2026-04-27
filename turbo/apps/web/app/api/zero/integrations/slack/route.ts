import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import { getConnectorProvidedSecretNames } from "@vm0/connectors/connector-utils";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import {
  resolveDefaultComposeId,
  getWorkspaceAgent,
} from "../../../../../src/lib/zero/slack-org/handlers/shared";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { listSecrets } from "../../../../../src/lib/zero/secret/secret-service";
import { listVariables } from "../../../../../src/lib/zero/variable/variable-service";
import { listConnectors } from "../../../../../src/lib/zero/connector/connector-service";
import { getOrgNameAndSlug } from "../../../../../src/lib/auth/org-cache";
import { createSlackClient } from "../../../../../src/lib/zero/slack";
import { getApiUrl } from "../../../../../src/lib/infra/callback";
import { publishAppHome } from "../../../../../src/lib/zero/slack/client";
import { buildAppHomeView } from "../../../../../src/lib/zero/slack/blocks";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import { refreshOrgAppHome } from "../../../../../src/lib/zero/slack-org/handlers/app-home";
import { cleanupWorkspaceInstallation } from "../../../../../src/lib/zero/slack-org/connect-service";
import { hasAllBotScopes } from "../../../../../src/lib/zero/slack-org/scopes";
import type { AgentComposeYaml } from "../../../../../src/lib/infra/agent-compose/types";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:zero:slack");

/**
 * GET /api/zero/integrations/slack
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
  const { org, member } = await resolveOrg(authCtx);

  const db = globalThis.services.db;

  // Find the workspace installation for this org
  const [orgInstallation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, org.orgId))
    .limit(1);

  // Find user's connection via workspace
  const [connection] = orgInstallation
    ? await db
        .select()
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.vm0UserId, userId),
            eq(
              slackOrgConnections.slackWorkspaceId,
              orgInstallation.slackWorkspaceId,
            ),
          ),
        )
        .limit(1)
    : [];

  if (!connection) {
    const installation = orgInstallation;

    const isAdmin = member.role === "admin";
    const { SLACK_CLIENT_ID } = env();
    const baseUrl = SLACK_CLIENT_ID ? getApiUrl() : null;

    // Build install URL for admins when no workspace is installed
    let installUrl: string | null = null;
    if (isAdmin && !installation && baseUrl) {
      const url = new URL(`${baseUrl}/api/zero/slack/oauth/install`);
      url.searchParams.set("orgId", org.orgId);
      url.searchParams.set("vm0UserId", userId);
      installUrl = url.toString();
    }

    // Build connect URL for users who haven't linked their Slack identity yet.
    // Uses the OAuth connect flow to identify the user's Slack account.
    let connectUrl: string | null = null;
    if (installation && baseUrl) {
      const url = new URL(`${baseUrl}/api/zero/slack/oauth/connect`);
      url.searchParams.set("orgId", org.orgId);
      url.searchParams.set("vm0UserId", userId);
      connectUrl = url.toString();
    }

    // Scope mismatch detection (admin-only)
    const scopeFields =
      isAdmin && installation
        ? buildScopeFields(installation.botScopes, baseUrl, org.orgId, userId)
        : {};

    return NextResponse.json({
      isConnected: false,
      isInstalled: !!installation,
      isAdmin,
      installUrl,
      connectUrl,
      ...scopeFields,
    });
  }

  return getConnectedStatus(org.orgId, userId, member, orgInstallation);
}

/**
 * DELETE /api/zero/integrations/slack
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
  const { org, member } = await resolveOrg(authCtx);

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
    .select({ slackUserId: slackOrgConnections.slackUserId })
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
      connections.map((c) => {
        return publishAppHome(
          client,
          c.slackUserId,
          buildAppHomeView({ isLinked: false, isInstalled: false }),
        );
      }),
    );
  }

  // Clean up installation and all related data
  await cleanupWorkspaceInstallation(installation.slackWorkspaceId);

  log.info("Slack workspace uninstalled", {
    workspaceId: installation.slackWorkspaceId,
    orgId: org.orgId,
    uninstalledBy: authCtx.userId,
  });

  return NextResponse.json({ ok: true });
}

async function getConnectedStatus(
  orgId: string,
  userId: string,
  member: { role: string },
  installation: typeof slackOrgInstallations.$inferSelect | undefined,
): Promise<NextResponse> {
  const db = globalThis.services.db;

  const composeId = await resolveDefaultComposeId(orgId);
  let defaultAgentName: string | null = null;
  let agentOrgSlug: string | null = null;

  let requiredSecrets: string[] = [];
  let requiredVars: string[] = [];

  if (composeId) {
    const agent = await getWorkspaceAgent(composeId);
    defaultAgentName = agent?.displayName ?? agent?.name ?? null;

    const [compose] = await db
      .select({
        orgId: agentComposes.orgId,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId))
      .limit(1);

    if (compose) {
      agentOrgSlug = (await getOrgNameAndSlug(compose.orgId)).slug;

      if (compose.headVersionId) {
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
    }
  }

  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(orgId, userId),
    listVariables(orgId, userId),
    listConnectors(orgId, userId),
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

  const isAdmin = member.role === "admin";
  const { SLACK_CLIENT_ID } = env();
  const baseUrl = SLACK_CLIENT_ID ? getApiUrl() : null;

  const scopeFields =
    isAdmin && installation
      ? buildScopeFields(installation.botScopes, baseUrl, orgId, userId)
      : {};

  return NextResponse.json({
    isConnected: true,
    isInstalled: true,
    workspaceName: installation?.slackWorkspaceName ?? null,
    isAdmin,
    defaultAgentName,
    agentOrgSlug,
    environment: {
      requiredSecrets,
      requiredVars,
      missingSecrets,
      missingVars,
    },
    ...scopeFields,
  });
}

/**
 * Build scope-mismatch fields for the status response (admin-only).
 */
function buildScopeFields(
  storedBotScopes: string | null,
  baseUrl: string | null,
  orgId: string,
  userId: string,
): { scopeMismatch: boolean; reinstallUrl: string | null } {
  const parsed: unknown = storedBotScopes ? JSON.parse(storedBotScopes) : null;
  const stored: string[] | null = Array.isArray(parsed) ? parsed : null;
  const scopeMismatch = !hasAllBotScopes(stored);

  let reinstallUrl: string | null = null;
  if (scopeMismatch && baseUrl) {
    const url = new URL(`${baseUrl}/api/zero/slack/oauth/install`);
    url.searchParams.set("orgId", orgId);
    url.searchParams.set("vm0UserId", userId);
    url.searchParams.set("reinstall", "1");
    reinstallUrl = url.toString();
  }

  return { scopeMismatch, reinstallUrl };
}

async function handleDisconnect(authCtx: { userId: string }) {
  const { userId } = authCtx;
  const { org } = await resolveOrg(authCtx);
  const { SECRETS_ENCRYPTION_KEY } = env();
  const db = globalThis.services.db;

  // Find installation for this org, then find user's connection via workspace
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, org.orgId))
    .limit(1);

  const [connection] = installation
    ? await db
        .select()
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.vm0UserId, userId),
            eq(
              slackOrgConnections.slackWorkspaceId,
              installation.slackWorkspaceId,
            ),
          ),
        )
        .limit(1)
    : [];

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

  // Refresh App Home (best-effort) — installation already fetched above
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
