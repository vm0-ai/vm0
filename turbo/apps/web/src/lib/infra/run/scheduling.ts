import { and, eq, gt } from "drizzle-orm";
import { runnerState } from "../../../db/schema/runner-state";

const STALE_THRESHOLD_MS = 60_000;

/**
 * Find the best runner for a job based on session affinity and available capacity.
 * Returns null if no suitable runner found (falls back to broadcast dispatch).
 */
export async function findBestRunner(
  group: string,
  profile: string,
  sessionId: string | null,
): Promise<{ runnerId: string } | null> {
  // No session to match → broadcast dispatch is better (no deferred poll penalty)
  if (!sessionId) return null;

  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  const runners = await globalThis.services.db
    .select({
      runnerId: runnerState.runnerId,
      maxConcurrent: runnerState.maxConcurrent,
      runningCount: runnerState.runningCount,
      heldSessions: runnerState.heldSessions,
      profiles: runnerState.profiles,
    })
    .from(runnerState)
    .where(
      and(
        eq(runnerState.runnerGroup, group),
        gt(runnerState.lastSeenAt, staleThreshold),
        eq(runnerState.mode, "running"),
      ),
    );

  const candidates = runners.filter((r) => {
    // max_concurrent=0 means unlimited capacity on the runner side
    const hasCapacity =
      r.maxConcurrent === 0 || r.maxConcurrent > r.runningCount;
    return hasCapacity && r.profiles.includes(profile);
  });

  if (candidates.length === 0) return null;

  const affinityRunner = candidates.find((r) => {
    return r.heldSessions.includes(sessionId);
  });

  if (!affinityRunner) return null;

  return { runnerId: affinityRunner.runnerId };
}
