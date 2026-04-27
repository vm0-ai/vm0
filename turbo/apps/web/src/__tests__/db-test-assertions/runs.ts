import { and, desc, eq, like } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { sandboxTelemetry } from "@vm0/db/schema/sandbox-telemetry";

/**
 * Find agent runs matching a given userId and prompt.
 */
export async function findTestRunsByUserAndPrompt(
  userId: string,
  prompt: string,
) {
  initServices();
  return globalThis.services.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.prompt, prompt)));
}

/**
 * Find agent runs by user ID where prompt contains the given substring.
 * Useful when the full prompt is not known (e.g., when attachments are appended).
 */
export async function findTestRunsByUserAndPromptContaining(
  userId: string,
  promptSubstring: string,
) {
  initServices();
  return globalThis.services.db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        like(agentRuns.prompt, `%${promptSubstring}%`),
      ),
    );
}

/**
 * Look up a full agent run record by ID for verification in tests.
 *
 * Direct DB read is required because the GET /api/agent/runs/:id endpoint
 * does not expose internal fields like `vars`, `secretNames`,
 * or `lastHeartbeatAt` that integration tests need to verify.
 */
export async function findTestRunRecord(
  runId: string,
): Promise<typeof agentRuns.$inferSelect | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row;
}

/**
 * Look up zero_runs record by run ID for verification in tests.
 */
export async function findTestZeroRun(
  runId: string,
): Promise<typeof zeroRuns.$inferSelect | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row;
}

/**
 * Look up agent run callback records by run ID for verification in tests.
 *
 * Direct DB read is required because no API endpoint exposes callback
 * records — they are internal implementation details of the run dispatch.
 */
export async function findTestRunCallbacks(
  runId: string,
): Promise<Array<typeof agentRunCallbacks.$inferSelect>> {
  initServices();
  return globalThis.services.db
    .select()
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
}

/**
 * Find a queue entry by run ID.
 */
export async function findTestQueueEntry(runId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(agentRunQueue)
    .where(eq(agentRunQueue.runId, runId))
    .limit(1);
  return row;
}

/**
 * Find all callback records for a given run ID.
 */
export async function findTestCallbacksByRunId(runId: string) {
  initServices();
  return globalThis.services.db
    .select()
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
}

/**
 * Find the most recent agent run for a user in an org.
 * Used to verify that a run was dispatched (e.g., from a phone webhook).
 */
export async function findMostRecentRunForUser(
  userId: string,
  orgId: string,
): Promise<typeof agentRuns.$inferSelect | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.orgId, orgId)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row;
}

/**
 * Find sandbox telemetry record by run ID.
 */
export async function findTestSandboxTelemetry(
  runId: string,
): Promise<{ id: string } | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ id: sandboxTelemetry.id })
    .from(sandboxTelemetry)
    .where(eq(sandboxTelemetry.runId, runId))
    .limit(1);
  return row;
}

/**
 * Find checkpoint record by run ID for verification in tests.
 */
export async function findTestCheckpoint(
  runId: string,
): Promise<typeof checkpoints.$inferSelect | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.runId, runId))
    .limit(1);
  return row;
}
