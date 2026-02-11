import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
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

  return NextResponse.json({
    workspace: {
      id: installation.slackWorkspaceId,
      name: installation.slackWorkspaceName,
    },
    agent: compose ? { id: compose.id, name: compose.name } : null,
    environment: {
      requiredSecrets,
      requiredVars,
      missingSecrets,
      missingVars,
    },
  });
}
