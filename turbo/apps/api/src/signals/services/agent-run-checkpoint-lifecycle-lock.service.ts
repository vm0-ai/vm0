import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/** Serialize one run's checkpoint admission with its terminal transition. */
export async function lockAgentRunCheckpointLifecycle(
  tx: Tx,
  runId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent_run_checkpoint:${runId}`}, 0))`,
  );
}
