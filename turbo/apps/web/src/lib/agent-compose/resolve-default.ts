import { eq, and } from "drizzle-orm";
import { env } from "../../env";
import { agentComposes } from "../../db/schema/agent-compose";
import { getOrgBySlug } from "../scope/org-cache-service";
import { logger } from "../logger";

const log = logger("agent-compose:resolve-default");

/**
 * Resolve the default agent compose ID from VM0_DEFAULT_AGENT env var.
 * Format: "scope-slug/agent-name" (e.g. "yuma/deep-dive")
 *
 * Returns the compose ID if found, or null.
 */
export async function resolveDefaultAgentComposeId(): Promise<string | null> {
  const { VM0_DEFAULT_AGENT } = env();
  if (!VM0_DEFAULT_AGENT) {
    log.warn("VM0_DEFAULT_AGENT env var is not set");
    return null;
  }

  const [scopeSlug, agentName] = VM0_DEFAULT_AGENT.split("/");
  if (!scopeSlug || !agentName) {
    log.warn("VM0_DEFAULT_AGENT has invalid format, expected 'scope/name'", {
      value: VM0_DEFAULT_AGENT,
    });
    return null;
  }

  const orgData = await getOrgBySlug(scopeSlug);

  if (!orgData) {
    log.warn("Scope not found for VM0_DEFAULT_AGENT", { scopeSlug });
    return null;
  }

  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, orgData.orgId),
        eq(agentComposes.name, agentName),
      ),
    )
    .limit(1);

  if (!compose) {
    log.warn("Agent compose not found for VM0_DEFAULT_AGENT", {
      scopeSlug,
      agentName,
      orgId: orgData.orgId,
    });
    return null;
  }

  return compose.id;
}
