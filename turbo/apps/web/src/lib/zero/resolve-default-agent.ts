import { eq, and } from "drizzle-orm";
import { env } from "../../env";
import { agentComposes } from "../../db/schema/agent-compose";
import { orgMetadata } from "../../db/schema/org-metadata";
import { zeroAgents } from "../../db/schema/zero-agent";
import { getOrgBySlug } from "../org/org-cache-service";
import { logger } from "../logger";

const log = logger("zero:resolve-default-agent");

/**
 * Resolve the default zero-layer agent ID for an org.
 *
 * Primary path: reads defaultAgentId directly from org_metadata.
 *
 * Fallback path: parses VM0_DEFAULT_AGENT env var ("org-slug/agent-name"),
 * resolves the org, then queries zero_agents directly by (orgId, name).
 *
 * Returns the zero_agents.id or null if no default agent is configured.
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

/**
 * Reverse-resolve a zero agent UUID back to its compose UUID.
 * JOINs zero_agents → agent_composes via (orgId, name).
 * Returns the compose UUID or null if no matching compose exists.
 */
export async function resolveComposeIdFromAgentId(
  agentId: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
    .select({ composeId: agentComposes.id })
    .from(zeroAgents)
    .innerJoin(
      agentComposes,
      and(
        eq(agentComposes.orgId, zeroAgents.orgId),
        eq(agentComposes.name, zeroAgents.name),
      ),
    )
    .where(eq(zeroAgents.id, agentId))
    .limit(1);

  return row?.composeId ?? null;
}

/**
 * Check whether a given compose ID belongs to the org's default agent.
 * Reuses resolveDefaultAgentId (handles env-var fallback) and
 * resolveComposeIdFromAgentId for the reverse lookup.
 */
export async function isDefaultAgentCompose(
  orgId: string,
  composeId: string,
): Promise<boolean> {
  const defaultAgentId = await resolveDefaultAgentId(orgId);
  if (!defaultAgentId) return false;

  const defaultComposeId = await resolveComposeIdFromAgentId(defaultAgentId);
  return defaultComposeId === composeId;
}
