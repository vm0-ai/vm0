import { eq } from "drizzle-orm";
import type { StoredExecutionContext } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import { runnerJobQueue } from "../../db/schema/runner-job-queue";

/**
 * Find a runner job queue entry by run ID.
 * Returns the entry with typed execution context, or undefined if not found.
 */
export async function findTestRunnerJobEntry(runId: string) {
  initServices();
  const rows = await globalThis.services.db
    .select()
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row,
    executionContext: row.executionContext as StoredExecutionContext,
  };
}
