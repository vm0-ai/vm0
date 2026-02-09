import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../../src/lib/logger";
import { eq } from "drizzle-orm";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { agentComposeVersions } from "../../../../../src/db/schema/agent-compose";
import { secrets } from "../../../../../src/db/schema/secret";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import type { AgentComposeYaml } from "../../../../../src/types/agent-compose";

const log = logger("api:agents:missing-secrets");

/**
 * Agent with missing secrets information
 */
interface AgentMissingSecrets {
  composeId: string;
  agentName: string;
  requiredSecrets: string[]; // All secrets required by agent
  missingSecrets: string[]; // Secrets that are required but not configured
}

/**
 * GET /api/agent/schedules/missing-secrets
 * Check all user's agents for missing secrets
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

  log.debug(`Checking missing secrets for user ${userId}`);

  const db = globalThis.services.db;

  // Get all user's agents
  const agents = await db
    .select({
      composeId: agentComposes.id,
      agentName: agentComposes.name,
      scopeId: agentComposes.scopeId,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.userId, userId));

  if (agents.length === 0) {
    return NextResponse.json({ agents: [] });
  }

  // Get user's scope ID from first agent (all agents belong to same user scope)
  const userScopeId = agents[0]!.scopeId;

  // Get all user's configured secrets (only names, not values)
  const userSecrets = await db
    .select({ name: secrets.name })
    .from(secrets)
    .where(eq(secrets.scopeId, userScopeId));

  const configuredSecretNames = new Set(userSecrets.map((s) => s.name));

  const result: AgentMissingSecrets[] = [];

  for (const agent of agents) {
    if (!agent.headVersionId) {
      log.debug(`Agent ${agent.agentName} has no head version, skipping`);
      continue;
    }

    // Get compose content from version
    const [version] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, agent.headVersionId))
      .limit(1);

    if (!version) {
      log.warn(
        `Version ${agent.headVersionId} not found for agent ${agent.agentName}`,
      );
      continue;
    }

    const composeYaml = version.content as AgentComposeYaml;

    // Extract required secrets from compose environment
    const agentDefs = Object.values(composeYaml.agents || {});
    const firstAgent = agentDefs[0];

    if (!firstAgent?.environment) {
      // No environment variables means no secrets required
      continue;
    }

    // Extract all variable references from environment
    const refs = extractVariableReferences(firstAgent.environment);
    const grouped = groupVariablesBySource(refs);

    // Get required secrets (both ${{ secrets.xxx }} and ${{ credentials.xxx }})
    const requiredSecrets = [
      ...grouped.secrets.map((r) => r.name),
      ...grouped.credentials.map((r) => r.name),
    ];

    if (requiredSecrets.length === 0) {
      // No secrets required
      continue;
    }

    // Find missing secrets
    const missingSecrets = requiredSecrets.filter(
      (secret) => !configuredSecretNames.has(secret),
    );

    if (missingSecrets.length > 0) {
      result.push({
        composeId: agent.composeId,
        agentName: agent.agentName,
        requiredSecrets,
        missingSecrets,
      });
    }
  }

  log.debug(
    `Found ${result.length} agent(s) with missing secrets for user ${userId}`,
  );

  return NextResponse.json({
    agents: result,
  });
}
