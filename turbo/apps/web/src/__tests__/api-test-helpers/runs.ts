import { generateSandboxToken } from "../../lib/auth/sandbox-token";
import { POST as createRunRoute } from "../../../app/api/agent/runs/route";
import { POST as checkpointWebhook } from "../../../app/api/webhooks/agent/checkpoints/route";
import { POST as completeWebhook } from "../../../app/api/webhooks/agent/complete/route";
import type { VolumeVersionsSnapshot } from "../../lib/infra/checkpoint/types";
import { findTestRunRecord } from "../db-test-assertions/runs";
import { createTestRequest } from "./core";

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
  enqueueTestRun,
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

export async function createTestRun(
  agentComposeId: string,
  prompt: string,
  options?: {
    vars?: Record<string, string>;
    secrets?: Record<string, string>;
    sessionId?: string;
    checkpointId?: string;
    appendSystemPrompt?: string;
    additionalVolumes?: Array<{
      name: string;
      version?: string;
      mountPath: string;
    }>;
    permissionPolicies?: Record<string, Record<string, string>>;
    triggerSource?: string;
  },
): Promise<{ runId: string; status: string; sessionId?: string }> {
  const request = createTestRequest("http://localhost:3000/api/agent/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentComposeId,
      prompt,
      ...options,
    }),
  });
  const response = await createRunRoute(request);
  return response.json();
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
 * Create a test checkpoint via webhook route handler.
 * This is required before completing a run with exitCode=0.
 * Used internally by completeTestRun and exported for tests that need custom snapshots.
 */
export async function createTestCheckpoint(
  userId: string,
  runId: string,
  options?: {
    volumeVersionsSnapshot?: VolumeVersionsSnapshot;
  },
): Promise<{
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
}> {
  const sandboxToken = await generateSandboxToken(userId, runId, "org-test");
  const request = createTestRequest(
    "http://localhost:3000/api/webhooks/agent/checkpoints",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        runId,
        // Default to "claude-code" — the codebase's default framework and
        // what production webhooks actually persist. Keeping a placeholder
        // like "test-agent" creates false-positive mismatches in
        // build-zero-context's framework-compatibility check on resume.
        cliAgentType: "claude-code",
        cliAgentSessionId: `test-session-${runId}`,
        cliAgentSessionHistoryHash:
          "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
        ...options,
      }),
    },
  );
  const response = await checkpointWebhook(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create checkpoint: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
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
  // First create checkpoint (required for completed status)
  const checkpoint = await createTestCheckpoint(
    userId,
    runId,
    checkpointOptions,
  );

  // Then complete the run
  const sandboxToken = await generateSandboxToken(userId, runId, "org-test");
  const request = createTestRequest(
    "http://localhost:3000/api/webhooks/agent/complete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        runId,
        exitCode: 0,
        ...completeOptions,
      }),
    },
  );
  const response = await completeWebhook(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to complete run: ${error.error?.message || response.status}`,
    );
  }

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
  const sandboxToken = await generateSandboxToken(userId, runId, "org-test");
  const request = createTestRequest(
    "http://localhost:3000/api/webhooks/agent/complete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        runId,
        exitCode: 1,
        error: error ?? "test failure",
      }),
    },
  );
  const response = await completeWebhook(request);
  if (!response.ok) {
    const errorBody = await response.json();
    throw new Error(
      `Failed to fail run: ${(errorBody as { error?: { message?: string } }).error?.message || response.status}`,
    );
  }
}
