import { eq } from "drizzle-orm";
import { orgMetadata } from "@vm0/db/schema/org-metadata";

/**
 * Resolve the default zero-layer agent ID for an org.
 *
 * Primary path: reads defaultAgentId directly from org_metadata.
 * Since zero_agents.id = agentComposes.id (composeId), the returned
 * value can be used directly as both agentId and composeId.
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

  return orgRow?.defaultAgentId ?? null;
}
