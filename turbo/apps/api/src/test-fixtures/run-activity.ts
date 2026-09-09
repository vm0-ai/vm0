import { runActivitySnapshots } from "@okouai/db/schema/run-activity-snapshot";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { createDeferredPromise } from "../signals/utils";

/** Infrastructure-only time passage, scoped to a run created by this test. */
export async function advanceRunActivityClockFixture(
  runId: string,
  milliseconds: number,
): Promise<void> {
  await db()
    .update(runActivitySnapshots)
    .set({
      expiresAt: sql`${runActivitySnapshots.expiresAt} - ${milliseconds} * interval '1 millisecond'`,
      nextAttemptAt: sql`${runActivitySnapshots.nextAttemptAt} - ${milliseconds} * interval '1 millisecond'`,
      claimExpiresAt: sql`${runActivitySnapshots.claimExpiresAt} - ${milliseconds} * interval '1 millisecond'`,
    })
    .where(eq(runActivitySnapshots.runId, runId));
}

/** A stalled database writer is not constructible through a production API. */
export async function holdRunActivityFixture(
  runId: string,
  signal: AbortSignal,
) {
  const ready = createDeferredPromise<void>(signal);
  const release = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await tx
      .select({ runId: runActivitySnapshots.runId })
      .from(runActivitySnapshots)
      .where(eq(runActivitySnapshots.runId, runId))
      .for("update");
    ready.resolve(undefined);
    await release.promise;
  });
  await ready.promise;
  return {
    release: () => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    },
    done,
  };
}
