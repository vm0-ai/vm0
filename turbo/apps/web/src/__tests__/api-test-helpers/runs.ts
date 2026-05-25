import type {
  ArtifactSnapshotsPayload,
  VolumeVersionsSnapshot,
} from "../../lib/infra/checkpoint/types";
import { getTestAuthContext } from "./core";
import {
  markTestRunCompletedFromCheckpoint,
  markTestRunFailed,
  seedTestRun,
  seedTestCheckpointForRun,
} from "../db-test-seeders/runs";
import { findTestRunRecord } from "../db-test-assertions/runs";

// Re-exports: DB-direct seeders
export {
  markRunningRunsAsCompleted,
  setTestRunStatus,
  setTestRunResult,
  setTestRunModelProvider,
  setTestRunSelectedModel,
  setTestRunModelProviderMetadata,
  insertTestZeroRun,
  expireQueueEntry,
  insertTestQueueEntry,
  createTestCallback,
  linkRunToSchedule,
  insertTestConversation,
  insertTestSandboxTelemetry,
  insertTestUsageDaily,
} from "../db-test-seeders/runs";

// Re-exports: read-only assertions
export {
  findTestRunsByUserAndPrompt,
  findTestRunsByUserAndPromptContaining,
  findTestRunRecord,
  findTestCheckpoint,
  findTestZeroRun,
  findTestRunCallbacks,
  findTestQueueEntry,
  findTestCallbacksByRunId,
  findMostRecentRunForUser,
  findTestSandboxTelemetry,
} from "../db-test-assertions/runs";

type CreateTestRunOptions = Omit<
  NonNullable<Parameters<typeof seedTestRun>[2]>,
  "prompt"
>;

export async function createTestRun(
  agentComposeId: string,
  prompt: string,
  options?: CreateTestRunOptions,
): Promise<{ runId: string; status: string; sessionId?: string }> {
  const authContext = await getTestAuthContext();
  const { runId } = await seedTestRun(authContext.userId, agentComposeId, {
    ...options,
    orgId: options?.orgId ?? authContext.orgId,
    prompt,
  });
  const run = await findTestRunRecord(runId);
  if (!run) {
    throw new Error(`Failed to create test run: ${runId}`);
  }
  return { runId, status: run.status, sessionId: run.sessionId };
}

/**
 * Get test run details for assertions that inspect internal run fields.
 *
 * @param runId - The run ID to fetch
 * @returns The run details including status, error, etc.
 */
export async function getTestRun(runId: string): Promise<{
  id: string;
  status: string;
  error: string | null;
  completedAt: string | null;
  appendSystemPrompt: string | null;
}> {
  const data = await findTestRunRecord(runId);
  if (!data) {
    throw new Error(`Failed to get run: ${runId}`);
  }
  return {
    id: data.id,
    status: data.status,
    error: data.error ?? null,
    completedAt: data.completedAt?.toISOString() ?? null,
    appendSystemPrompt: data.appendSystemPrompt ?? null,
  };
}

/**
 * Create checkpoint state for tests that complete or resume a run.
 * Mirrors the persisted shape of the API-authoritative checkpoint webhook.
 */
export async function createTestCheckpoint(
  userId: string,
  runId: string,
  options?: {
    volumeVersionsSnapshot?: VolumeVersionsSnapshot;
    artifactSnapshots?: ArtifactSnapshotsPayload;
  },
): Promise<{
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
}> {
  return seedTestCheckpointForRun({
    userId,
    runId,
    volumeVersionsSnapshot: options?.volumeVersionsSnapshot,
    artifactSnapshots: options?.artifactSnapshots,
  });
}

/**
 * Complete a test run via checkpoint + complete webhooks.
 * Creates a checkpoint first, then completes the run with exitCode=0.
 * Sets the run status to "completed".
 *
 * @param userId - The user ID
 * @param runId - The run ID
 * @returns The checkpoint details
 */
export async function completeTestRun(
  userId: string,
  runId: string,
  checkpointOptions?: {
    volumeVersionsSnapshot?: { versions: Record<string, string> };
  },
  completeOptions?: {
    lastEventSequence?: number;
  },
): Promise<{
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
}> {
  const checkpoint = await createTestCheckpoint(
    userId,
    runId,
    checkpointOptions,
  );

  await markTestRunCompletedFromCheckpoint({
    userId,
    runId,
    checkpoint,
    volumeVersionsSnapshot: checkpointOptions?.volumeVersionsSnapshot,
    lastEventSequence: completeOptions?.lastEventSequence,
  });

  return checkpoint;
}

/**
 * Fail a test run via the complete webhook (exitCode=1).
 *
 * Unlike completeTestRun, no checkpoint is needed for a failed run.
 */
export async function failTestRun(
  userId: string,
  runId: string,
  error?: string,
): Promise<void> {
  await markTestRunFailed({ userId, runId, error });
}
