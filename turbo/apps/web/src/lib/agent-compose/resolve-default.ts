import { eq, and } from "drizzle-orm";
import { env } from "../../env";
import { agentComposes } from "../../db/schema/agent-compose";
import { scopes } from "../../db/schema/scope";

/**
 * Resolve the default agent compose ID from VM0_DEFAULT_AGENT env var.
 * Format: "scope-slug/agent-name" (e.g. "yuma/deep-dive")
 *
 * Returns the compose ID if found, or null.
 */
export async function resolveDefaultAgentComposeId(): Promise<string | null> {
  const { VM0_DEFAULT_AGENT } = env();
  if (!VM0_DEFAULT_AGENT) return null;

  const [scopeSlug, agentName] = VM0_DEFAULT_AGENT.split("/");
  if (!scopeSlug || !agentName) return null;

  const [scope] = await globalThis.services.db
    .select({ id: scopes.id })
    .from(scopes)
    .where(eq(scopes.slug, scopeSlug))
    .limit(1);

  if (!scope) return null;

  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.scopeId, scope.id),
        eq(agentComposes.name, agentName),
      ),
    )
    .limit(1);

  return compose?.id ?? null;
}
