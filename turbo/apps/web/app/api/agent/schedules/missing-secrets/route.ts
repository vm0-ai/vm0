import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { schedulesMissingSecretsContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { logger } from "../../../../../src/lib/logger";
import { eq } from "drizzle-orm";
import { secrets } from "../../../../../src/db/schema/secret";
import { extractAndGroupVariables } from "@vm0/core";
import {
  getUserAgents,
  batchFetchVersionContents,
} from "../../../../../src/lib/agent/get-user-agents";
import { resolveOrgOrNull } from "../../../../../src/lib/org/resolve-org";

const log = logger("api:agents:missing-secrets");

const router = tsr.router(schedulesMissingSecretsContract, {
  getMissingSecrets: async ({ query, headers }) => {
    initServices();

    const authResult = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:read",
    });
    if (isAuthError(authResult)) return authResult;
    const userId = authResult.userId;

    log.debug(`Checking missing secrets for user ${userId}`);

    const db = globalThis.services.db;

    const agents = await getUserAgents(userId);

    if (agents.length === 0) {
      return { status: 200 as const, body: { agents: [] } };
    }

    // Get user's org to query configured secrets
    const runtimeOrg = await resolveOrgOrNull(authResult, query.org);
    if (!runtimeOrg) {
      return { status: 200 as const, body: { agents: [] } };
    }

    const userSecrets = await db
      .select({ name: secrets.name })
      .from(secrets)
      .where(eq(secrets.orgId, runtimeOrg.orgId));

    const configuredSecretNames = new Set(userSecrets.map((s) => s.name));

    // Batch-fetch all versions in a single query
    const versionIds = agents
      .map((a) => a.headVersionId)
      .filter((id): id is string => id !== null);

    const versionContents = await batchFetchVersionContents(versionIds);

    const result: Array<{
      composeId: string;
      agentName: string;
      requiredSecrets: string[];
      missingSecrets: string[];
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

      if (requiredSecrets.length === 0) {
        continue;
      }

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

    return {
      status: 200 as const,
      body: { agents: result },
    };
  },
});

const handler = createHandler(schedulesMissingSecretsContract, router);

export { handler as GET };
