import { piMemoryPhase2Checkpoints } from "@okouai/db/schema/pi-memory-phase2-checkpoint";
import { and, eq, sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { ApiDb, Tx } from "../../lib/db-types";

type CheckpointReceipt = typeof piMemoryPhase2Checkpoints.$inferInsert;

/**
 * DB/API skew can expose new code before the receipt migration (~102 minutes).
 * Fence maintenance until it is visible; ordinary runs need no new relation.
 * Remove this probe under #31067 after migration and the API rollback window.
 */
export async function piMemoryPhase2CheckpointSchemaReady(
  db: ApiDb | Tx,
): Promise<boolean> {
  const [result] = await db
    .select({
      ready:
        sql`to_regclass('public.pi_memory_phase2_checkpoints') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return result?.ready === true;
}

export async function findPiMemoryPhase2Checkpoint(
  db: ApiDb | Tx,
  binding: Omit<CheckpointReceipt, "versionId" | "createdAt">,
): Promise<typeof piMemoryPhase2Checkpoints.$inferSelect | undefined> {
  if (!(await piMemoryPhase2CheckpointSchemaReady(db))) {
    return undefined;
  }
  const [receipt] = await db
    .select()
    .from(piMemoryPhase2Checkpoints)
    .where(
      and(
        eq(piMemoryPhase2Checkpoints.runId, binding.runId),
        eq(piMemoryPhase2Checkpoints.memoryStorageId, binding.memoryStorageId),
        eq(piMemoryPhase2Checkpoints.orgId, binding.orgId),
        eq(piMemoryPhase2Checkpoints.userId, binding.userId),
        eq(piMemoryPhase2Checkpoints.leaseToken, binding.leaseToken),
        eq(piMemoryPhase2Checkpoints.claimedRevision, binding.claimedRevision),
        eq(
          piMemoryPhase2Checkpoints.claimedBaseVersionId,
          binding.claimedBaseVersionId,
        ),
        eq(piMemoryPhase2Checkpoints.selectionDigest, binding.selectionDigest),
      ),
    )
    .limit(1);
  return receipt;
}

/** Called only inside the generic commit transaction, after validation/fencing. */
export async function recordPiMemoryPhase2Checkpoint(
  tx: Tx,
  receipt: CheckpointReceipt,
): Promise<void> {
  await tx.insert(piMemoryPhase2Checkpoints).values(receipt);
}
