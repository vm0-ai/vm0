import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../../src/lib/logger";
import { eq } from "drizzle-orm";
import { secrets } from "../../../../../src/db/schema/secret";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import {
  getUserAgents,
  batchFetchVersionContents,
} from "../../../../../src/lib/agent/get-user-agents";
import { getUserScopeByClerkId } from "../../../../../src/lib/scope/scope-service";

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

  const agents = await getUserAgents(userId);

  if (agents.length === 0) {
    return NextResponse.json({ agents: [] });
  }

  // Get user's scope to query configured secrets
  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    return NextResponse.json({ agents: [] });
  }

  // Check the recipient's own secrets — shared agents run with the
  // recipient's secrets, so missing ones need to be configured by them.
  const userSecrets = await db
    .select({ name: secrets.name })
    .from(secrets)
    .where(eq(secrets.scopeId, userScope.id));

  const configuredSecretNames = new Set(userSecrets.map((s) => s.name));

  // Batch-fetch all versions in a single query
  const versionIds = agents
    .map((a) => a.headVersionId)
    .filter((id): id is string => id !== null);

  const versionContents = await batchFetchVersionContents(versionIds);

  const result: AgentMissingSecrets[] = [];

  for (const agent of agents) {
    if (!agent.headVersionId) {
      continue;
    }

    const composeYaml = versionContents.get(agent.headVersionId);
    if (!composeYaml) {
      continue;
    }

    // Extract required secrets from compose environment
    const agentDefs = Object.values(composeYaml.agents || {});
    const firstAgent = agentDefs[0];

    if (!firstAgent?.environment) {
      continue;
    }

    const refs = extractVariableReferences(firstAgent.environment);
    const grouped = groupVariablesBySource(refs);

    // Get required secrets (both ${{ secrets.xxx }} and ${{ credentials.xxx }})
    const requiredSecrets = [
      ...grouped.secrets.map((r) => r.name),
      ...grouped.credentials.map((r) => r.name),
    ];

    if (requiredSecrets.length === 0) {
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
