import { eq, and } from "drizzle-orm";
import { env } from "../../env";
import { orgMetadata } from "../../db/schema/org-metadata";
import { zeroAgents } from "../../db/schema/zero-agent";
import { getOrgBySlug } from "../org/org-cache-service";
import { logger } from "../logger";

const log = logger("zero:resolve-default-agent");

/**
 * Resolve the default zero-layer agent ID for an org.
 *
 * Primary path: reads defaultAgentId directly from org_metadata.
 * Since zero_agents.id = agentComposes.id (composeId), the returned
 * value can be used directly as both agentId and composeId.
 *
 * Fallback path: parses VM0_DEFAULT_AGENT env var ("org-slug/agent-name"),
 * resolves the org, then queries zero_agents directly by (orgId, name).
 *
 * Returns the agent/compose ID or null if no default agent is configured.
 */
export async function resolveDefaultAgentId(
  orgId: string,
): Promise<string | null> {
  const [orgRow] = await globalThis.services.db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (orgRow?.defaultAgentId) return orgRow.defaultAgentId;

  // Fallback: resolve via VM0_DEFAULT_AGENT env var → zero_agents directly
  return resolveDefaultAgentIdFromEnv();
}

/**
 * Resolve the default agent ID from the VM0_DEFAULT_AGENT env var.
 * Format: "org-slug/agent-name" (e.g. "yuma/deep-dive")
 *
 * Queries zero_agents directly by (orgId, name).
 */
async function resolveDefaultAgentIdFromEnv(): Promise<string | null> {
  const { VM0_DEFAULT_AGENT } = env();
  if (!VM0_DEFAULT_AGENT) {
    log.warn("VM0_DEFAULT_AGENT env var is not set");
    return null;
  }

  const [orgSlug, agentName] = VM0_DEFAULT_AGENT.split("/");
  if (!orgSlug || !agentName) {
    log.warn("VM0_DEFAULT_AGENT has invalid format, expected 'org/name'", {
      value: VM0_DEFAULT_AGENT,
    });
    return null;
  }

  const orgData = await getOrgBySlug(orgSlug);
  if (!orgData) {
    log.warn("Org not found for VM0_DEFAULT_AGENT", { orgSlug });
    return null;
  }

  const [agent] = await globalThis.services.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(eq(zeroAgents.orgId, orgData.orgId), eq(zeroAgents.name, agentName)),
    )
    .limit(1);

  if (!agent) {
    log.warn("Zero agent not found for VM0_DEFAULT_AGENT", {
      orgSlug,
      agentName,
      orgId: orgData.orgId,
    });
    return null;
  }

  return agent.id;
}

/**
 * Check whether a given compose/agent ID belongs to the org's default agent.
 * Since zero_agents.id = agent_composes.id (unified PK), we can compare directly.
 */
export async function isDefaultAgentCompose(
  orgId: string,
  composeId: string,
): Promise<boolean> {
  const defaultAgentId = await resolveDefaultAgentId(orgId);
  if (!defaultAgentId) return false;

  // With unified IDs, agentId === composeId — no reverse lookup needed
  return defaultAgentId === composeId;
}
