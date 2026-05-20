import { eq, and } from "drizzle-orm";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

/**
 * Resolve zero_agents.id by org + compose name.
 * Returns null if no matching agent exists.
 */
export async function resolveAgentId(
  orgId: string,
  composeName: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, composeName)))
    .limit(1);
  return row?.id ?? null;
}
