import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "../../db/schema/org-metadata";

// ============================================================================
// Phone Assertions
// ============================================================================

/**
 * Get the AgentPhone provisioning config for an org from org_metadata.
 * Used to verify that setup correctly saved the agent/number IDs.
 */
export async function getOrgAgentphoneConfig(orgId: string): Promise<{
  agentphoneAgentId: string | null;
  agentphoneNumberId: string | null;
  agentphoneNumber: string | null;
}> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      agentphoneAgentId: orgMetadata.agentphoneAgentId,
      agentphoneNumberId: orgMetadata.agentphoneNumberId,
      agentphoneNumber: orgMetadata.agentphoneNumber,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return {
    agentphoneAgentId: row?.agentphoneAgentId ?? null,
    agentphoneNumberId: row?.agentphoneNumberId ?? null,
    agentphoneNumber: row?.agentphoneNumber ?? null,
  };
}
