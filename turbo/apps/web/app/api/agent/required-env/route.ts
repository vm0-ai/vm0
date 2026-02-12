import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../src/lib/logger";
import { eq } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";

const log = logger("api:agents:required-env");

interface AgentRequiredEnv {
  composeId: string;
  agentName: string;
  requiredSecrets: string[];
  requiredVariables: string[];
}

/**
 * GET /api/agent/required-env
 * Returns all required secrets and variables for each of the user's agents.
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

  log.debug(`Checking required env for user ${userId}`);

  const db = globalThis.services.db;

  const agents = await db
    .select({
      composeId: agentComposes.id,
      agentName: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.userId, userId));

  if (agents.length === 0) {
    return NextResponse.json({ agents: [] });
  }

  const result: AgentRequiredEnv[] = [];

  for (const agent of agents) {
    if (!agent.headVersionId) {
      continue;
    }

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
    const agentDefs = Object.values(composeYaml.agents || {});
    const firstAgent = agentDefs[0];

    if (!firstAgent?.environment) {
      continue;
    }

    const refs = extractVariableReferences(firstAgent.environment);
    const grouped = groupVariablesBySource(refs);

    const requiredSecrets = [
      ...grouped.secrets.map((r) => r.name),
      ...grouped.credentials.map((r) => r.name),
    ];
    const requiredVariables = grouped.vars.map((r) => r.name);

    if (requiredSecrets.length === 0 && requiredVariables.length === 0) {
      continue;
    }

    result.push({
      composeId: agent.composeId,
      agentName: agent.agentName,
      requiredSecrets,
      requiredVariables,
    });
  }

  log.debug(
    `Found ${result.length} agent(s) with required env for user ${userId}`,
  );

  return NextResponse.json({ agents: result });
}
