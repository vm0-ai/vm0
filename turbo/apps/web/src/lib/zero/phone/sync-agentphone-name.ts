import { eq } from "drizzle-orm";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { getAgentPhoneClient } from "./agentphone-client";
import { buildReceptionistPrompt } from "./receptionist-prompt";
import { logger } from "../../shared/logger";

const log = logger("phone:sync-name");

/**
 * Sync the AgentPhone hosted agent's name and system prompt
 * to match the org's default agent display name.
 *
 * Called on:
 * 1. Phone setup (initial creation)
 * 2. Agent metadata update (when default agent is renamed)
 */
export async function syncAgentPhoneName(
  orgId: string,
  agentName: string,
): Promise<void> {
  const [org] = await globalThis.services.db
    .select({ agentphoneAgentId: orgMetadata.agentphoneAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!org?.agentphoneAgentId) {
    return; // Phone not configured for this org
  }

  const client = getAgentPhoneClient();
  await client.agents.updateAgent({
    agent_id: org.agentphoneAgentId,
    name: agentName,
    systemPrompt: buildReceptionistPrompt(agentName),
    beginMessage: `Hello, you've reached ${agentName}. How can I help you today?`,
  });

  log.info("AgentPhone agent name synced", { orgId, agentName });
}
