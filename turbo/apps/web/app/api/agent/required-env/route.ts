import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { requiredEnvContract, extractAndGroupVariables } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-auth-context";
import { logger } from "../../../../src/lib/logger";
import {
  getUserAgents,
  batchFetchVersionContents,
} from "../../../../src/lib/agent/get-user-agents";

const log = logger("api:agents:required-env");

const router = tsr.router(requiredEnvContract, {
  getRequiredEnv: async ({ headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);

    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    log.debug(`Checking required env for user ${userId}`);

    const agents = await getUserAgents(userId);

    if (agents.length === 0) {
      return { status: 200 as const, body: { agents: [] } };
    }

    // Batch-fetch all versions in a single query
    const versionIds = agents
      .map((a) => a.headVersionId)
      .filter((id): id is string => id !== null);

    const versionContents = await batchFetchVersionContents(versionIds);

    const result: Array<{
      composeId: string;
      agentName: string;
      requiredSecrets: string[];
      requiredVariables: string[];
    }> = [];

    for (const agent of agents) {
      if (!agent.headVersionId) {
        continue;
      }

      const composeYaml = versionContents.get(agent.headVersionId);
      if (!composeYaml) {
        continue;
      }

      const agentDefs = Object.values(composeYaml.agents || {});
      const firstAgent = agentDefs[0];

      if (!firstAgent?.environment) {
        continue;
      }

      const grouped = extractAndGroupVariables(firstAgent.environment);

      const requiredSecrets = grouped.secrets.map((r) => r.name);
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

    return {
      status: 200 as const,
      body: { agents: result },
    };
  },
});

const handler = createHandler(requiredEnvContract, router);

export { handler as GET };
