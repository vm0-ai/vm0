import { eq, and } from "drizzle-orm";
import { env } from "../../env";
import { orgMetadata } from "../../db/schema/org-metadata";
import { agentComposes } from "../../db/schema/agent-compose";
import { zeroAgents } from "../../db/schema/zero-agent";
import { getOrgBySlug } from "../org/org-cache-service";
import { logger } from "../logger";

const log = logger("zero:resolve-default-agent");

/**
 * Resolve the default zero-layer agent ID for an org.
 *
 * Primary path: reads defaultAgentComposeId from org_metadata, then JOINs
 * agent_composes with zero_agents via (orgId, name) to get the agent ID.
 *
 * Fallback path: parses VM0_DEFAULT_AGENT env var ("org-slug/agent-name"),
 * resolves the org, then queries zero_agents directly by (orgId, name).
 *
 * Returns the zero_agents.id or null if no default agent is configured.
 */
export async function resolveDefaultAgentId(
  orgId: string,
): Promise<string | null> {
  // 1. Look up default compose ID from org_metadata
  const [orgRow] = await globalThis.services.db
    .select({ defaultAgentComposeId: orgMetadata.defaultAgentComposeId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  const composeId = orgRow?.defaultAgentComposeId ?? null;

  if (composeId) {
    // 2a. Primary path: resolve via compose → zero agent JOIN
    const [row] = await globalThis.services.db
      .select({ agentId: zeroAgents.id })
      .from(agentComposes)
      .innerJoin(
        zeroAgents,
        and(
          eq(zeroAgents.orgId, agentComposes.orgId),
          eq(zeroAgents.name, agentComposes.name),
        ),
      )
      .where(eq(agentComposes.id, composeId))
      .limit(1);

    if (row) return row.agentId;
  }

  // 2b. Fallback: resolve via VM0_DEFAULT_AGENT env var → zero_agents directly
  return resolveDefaultAgentIdFromEnv();
}

/**
 * Resolve the default agent ID from the VM0_DEFAULT_AGENT env var.
 * Format: "org-slug/agent-name" (e.g. "yuma/deep-dive")
 *
 * Queries zero_agents directly by (orgId, name) — no agentComposes needed.
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
