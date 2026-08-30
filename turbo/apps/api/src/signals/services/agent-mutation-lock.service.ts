import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/** Serialize canonical mutations with the retained Stage 6 legacy bridge. */
export async function lockCanonicalAgentMutation(
  tx: Pick<Tx, "execute">,
  agentId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent:' || ${agentId}::text, 0))`,
  );
}

/** Serialize the seven-public-Agent check, including an initially empty org. */
export async function lockCanonicalAgentPublicLimit(
  tx: Pick<Tx, "execute">,
  orgId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent-public-limit:' || ${orgId}::text, 0))`,
  );
}
