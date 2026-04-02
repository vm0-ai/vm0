import { eq } from "drizzle-orm";
import { env } from "../../env";
import { orgMetadata } from "../../db/schema/org-metadata";

/**
 * Resolve the default zero-layer agent ID for an org.
 *
 * Primary path: reads defaultAgentId directly from org_metadata.
 * Since zero_agents.id = agentComposes.id (composeId), the returned
 * value can be used directly as both agentId and composeId.
 *
 * Fallback path: returns VM0_DEFAULT_AGENT env var value directly
 * (expected to be an agent/compose UUID).
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

  // Fallback: return VM0_DEFAULT_AGENT env var directly (agent/compose UUID)
  return resolveDefaultAgentIdFromEnv();
}

/**
 * Resolve the default agent ID from the VM0_DEFAULT_AGENT env var.
 * The env var should contain a direct agent/compose UUID.
 */
function resolveDefaultAgentIdFromEnv(): string | null {
  return env().VM0_DEFAULT_AGENT ?? null;
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
