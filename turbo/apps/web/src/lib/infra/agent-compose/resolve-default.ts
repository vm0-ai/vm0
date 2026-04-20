import { env } from "../../../env";

/**
 * Resolve the default agent compose ID from VM0_DEFAULT_AGENT env var.
 *
 * The env var should contain a direct agent/compose UUID.
 * Since zero_agents.id = agentComposes.id (unified PK), the returned
 * value can be used as both agentId and composeId.
 *
 * Returns the compose ID if set, or null.
 */
export function resolveDefaultAgentComposeId(): string | null {
  return env().VM0_DEFAULT_AGENT ?? null;
}
