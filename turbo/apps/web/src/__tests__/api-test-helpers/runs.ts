import { and, eq, like, or, sql } from "drizzle-orm";
import type { OrgTier } from "@vm0/core";
import { generateSandboxToken } from "../../lib/auth/sandbox-token";
import { agentRuns } from "../../db/schema/agent-run";
import { zeroRuns } from "../../db/schema/zero-run";
import { agentRunCallbacks } from "../../db/schema/agent-run-callback";
import { agentRunQueue } from "../../db/schema/agent-run-queue";
import { conversations } from "../../db/schema/conversation";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { sandboxTelemetry } from "../../db/schema/sandbox-telemetry";
import { usageDaily } from "../../db/schema/usage-daily";
import { initServices } from "../../lib/init-services";
import { uniqueId } from "../test-helpers";
import { resolveStartRunCompose } from "../../lib/zero/zero-run-validation";
import {
  authorizeCompose,
  validateComposeRequirements,
  checkRunConcurrencyLimit,
} from "../../lib/zero/zero-run-policy";
import { buildInfraExecutionContext } from "../../lib/infra/run/context/build-context";
import {
  loadCompose,
  insertRunRecord,
  buildAndDispatchRun,
  markRunFailed,
  registerCallbacks,
  type CreateRunResult,
} from "../../lib/infra/run/run-service";
import { generateCallbackSecret } from "../../lib/infra/callback/hmac";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";
import { enqueueRun } from "../../lib/zero/zero-run-queue-service";
import { POST as createRunRoute } from "../../../app/api/agent/runs/route";
import { GET as getRunByIdRoute } from "../../../app/api/agent/runs/[id]/route";
import { POST as checkpointWebhook } from "../../../app/api/webhooks/agent/checkpoints/route";
import { POST as completeWebhook } from "../../../app/api/webhooks/agent/complete/route";
import { createTestRequest } from "./core";

export type { CreateRunResult };

/**
 * Resolve orgId from a compose version ID.
 * Shared by test helpers that insert agent_runs records directly.
 */
export async function getOrgIdFromVersion(versionId: string): Promise<string> {
  const [row] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposes.id, agentComposeVersions.composeId),
    )
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);
  if (!row) {
    throw new Error(`Compose version ${versionId} not found`);
  }
  return row.orgId;
}

/**
 * Create a run record directly in the database.
 * Internal helper - use createTestRunInDb or createOrphanTestRun.
 */
async function createTestRunDirect(
  userId: string,
  versionId: string,
  orgId: string,
  options?: {
    status?: string;
    prompt?: string;
    continuedFromSessionId?: string;
    scheduleId?: string;
    triggerSource?: string;
    createdAt?: Date;
    startedAt?: Date;
    completedAt?: Date;
    result?: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      status: options?.status ?? "running",
      prompt: options?.prompt ?? "test prompt",
      continuedFromSessionId: options?.continuedFromSessionId,
      ...(options?.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options?.startedAt ? { startedAt: options.startedAt } : {}),
      ...(options?.completedAt ? { completedAt: options.completedAt } : {}),
      ...(options?.result ? { result: options.result } : {}),
    })
    .returning({ id: agentRuns.id });

  await globalThis.services.db.insert(zeroRuns).values({
    id: run!.id,
    triggerSource: options?.triggerSource ?? "cli",
    scheduleId: options?.scheduleId ?? null,
  });

  return run!;
}

/**
 * Create a run with no compose version (simulates deleted compose).
 * Useful for testing that endpoints handle orphan runs gracefully.
 */
export async function createOrphanTestRun(
  userId: string,
  orgId: string,
  options?: { status?: string; prompt?: string },
): Promise<{ runId: string }> {
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: null,
      status: options?.status ?? "completed",
      prompt: options?.prompt ?? "orphan run prompt",
    })
    .returning({ id: agentRuns.id });
  return { runId: run!.id };
}

/**
 * Create a run record directly in the database, bypassing the API route and dispatch.
 * Use this when you need a run in a specific status without triggering dispatch logic
 * (e.g., for cron cleanup tests that need runs in pending/running state).
 */
export async function createTestRunInDb(
  userId: string,
  agentComposeId: string,
  options?: {
    status?: string;
    prompt?: string;
    continuedFromSessionId?: string;
    scheduleId?: string;
    triggerSource?: string;
    createdAt?: Date;
    orgId?: string;
    startedAt?: Date;
    completedAt?: Date;
    result?: Record<string, unknown>;
  },
): Promise<{ runId: string }> {
  // Look up orgId from compose
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) {
    throw new Error(`Compose ${agentComposeId} not found`);
  }
  // Create a version for the run
  const versionId = uniqueId("version");
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: agentComposeId,
    content: { name: "test-agent", model: "claude-3-5-sonnet-20241022" },
    createdBy: userId,
  });
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, agentComposeId));

  // Create run directly (use provided orgId or fall back to compose orgId)
  const run = await createTestRunDirect(
    userId,
    versionId,
    options?.orgId ?? compose.orgId,
    {
      status: options?.status ?? "pending",
      prompt: options?.prompt ?? "test prompt",
      continuedFromSessionId: options?.continuedFromSessionId,
      scheduleId: options?.scheduleId,
      triggerSource: options?.triggerSource,
      createdAt: options?.createdAt,
      startedAt: options?.startedAt,
      completedAt: options?.completedAt,
      result: options?.result,
    },
  );
  return { runId: run.id };
}

export async function createTestRun(
  agentComposeId: string,
  prompt: string,
  options?: {
    vars?: Record<string, string>;
    secrets?: Record<string, string>;
    sessionId?: string;
    checkpointId?: string;
    memoryName?: string;
    appendSystemPrompt?: string;
    permissionPolicies?: Record<string, Record<string, string>>;
  },
): Promise<{ runId: string; status: string }> {
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
 * Test helper that mirrors the CLI API route pipeline (resolve → authorize →
 * validate → concurrency check → insert → token → context → dispatch).
 *
 * Used by tests that need fine-grained control over run creation params
 * (e.g., version pinning, concurrency testing) without going through HTTP.
 */
export interface CliRunParams {
  userId: string;
  agentComposeVersionId: string;
  prompt: string;
  orgTier: OrgTier;
  appendSystemPrompt?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  checkpointId?: string;
  sessionId?: string;
  conversationId?: string;
  callbacks?: Array<{ url: string; secret: string; payload: unknown }>;
  memoryName?: string;
  artifactName?: string;
  artifactVersion?: string;
  volumeVersions?: Record<string, string>;
  debugNoMockClaude?: boolean;
  captureNetworkBodies?: boolean;
}

export async function createCliRun(
  params: CliRunParams,
): Promise<CreateRunResult> {
  const composeMeta = await resolveStartRunCompose(params);

  const apiStartTime = Date.now();
  const { composeContent, compose } = await loadCompose(
    composeMeta.agentComposeVersionId,
    composeMeta.composeId,
  );
  authorizeCompose(params.userId, compose.orgId, compose);
  const authorizeTime = Date.now();

  if (!params.checkpointId && !params.sessionId) {
    await validateComposeRequirements(composeContent);
  }

  const orgId = compose.orgId;
  const run = await globalThis.services.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
    await checkRunConcurrencyLimit(orgId, params.orgTier, tx);
    return insertRunRecord(tx, {
      userId: params.userId,
      orgId,
      agentComposeVersionId: composeMeta.agentComposeVersionId,
      prompt: params.prompt,
      appendSystemPrompt: params.appendSystemPrompt,
      vars: params.vars,
      secrets: params.secrets,
      resumedFromCheckpointId: params.checkpointId,
      sessionId: params.sessionId,
    });
  });
  const transactionTime = Date.now();

  const sandboxToken = await generateSandboxToken(params.userId, run.id);
  const tokenTime = Date.now();

  try {
    if (params.callbacks && params.callbacks.length > 0) {
      await registerCallbacks(run.id, params.callbacks);
    }

    const { context } = buildInfraExecutionContext({
      runId: run.id,
      userId: params.userId,
      orgId,
      agentComposeVersionId: composeMeta.agentComposeVersionId,
      agentCompose: composeContent,
      prompt: params.prompt,
      sandboxToken,
      appendSystemPrompt: params.appendSystemPrompt,
      vars: params.vars,
      secrets: params.secrets,
      artifactName: params.artifactName,
      artifactVersion: params.artifactVersion,
      memoryName: params.memoryName,
      volumeVersions: params.volumeVersions,
      agentName: composeMeta.agentName,
      resumedFromCheckpointId: params.checkpointId,
      continuedFromSessionId: params.sessionId,
      debugNoMockClaude: params.debugNoMockClaude,
      captureNetworkBodies: params.captureNetworkBodies,
    });

    const result = await buildAndDispatchRun({
      runId: run.id,
      context,
      timings: {
        apiStart: apiStartTime,
        authorize: authorizeTime,
        transaction: transactionTime,
        token: tokenTime,
      },
    });

    return {
      runId: run.id,
      status: result.status,
      sandboxId: result.sandboxId,
      createdAt: run.createdAt,
    };
  } catch (error) {
    await markRunFailed(run.id, error);
    throw error;
  }
}

/**
 * Get test run details via internal API route handler.
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
  const request = createTestRequest(
    `http://localhost:3000/api/agent/runs/${runId}`,
  );
  const response = await getRunByIdRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to get run: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return {
    id: data.runId,
    status: data.status,
    error: data.error ?? null,
    completedAt: data.completedAt ?? null,
    appendSystemPrompt: data.appendSystemPrompt ?? null,
  };
}

/**
 * Create a test checkpoint via webhook route handler.
 * This is required before completing a run with exitCode=0.
 * Used internally by completeTestRun.
 */
async function createTestCheckpoint(
  userId: string,
  runId: string,
): Promise<{
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
}> {
  const sandboxToken = await generateSandboxToken(userId, runId);
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
        cliAgentType: "test-agent",
        cliAgentSessionId: `test-session-${runId}`,
        cliAgentSessionHistoryHash:
          "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
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
): Promise<{
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
}> {
  // First create checkpoint (required for completed status)
  const checkpoint = await createTestCheckpoint(userId, runId);

  // Then complete the run
  const sandboxToken = await generateSandboxToken(userId, runId);
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
  const sandboxToken = await generateSandboxToken(userId, runId);
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

/**
 * Create a completed agent run with controlled timestamps.
 *
 * Direct DB insert is required because createdAt uses PostgreSQL defaultNow()
 * which cannot be controlled via the API or JavaScript fake timers. Tests for
 * date-range logic (cron aggregation, usage API boundaries) need runs placed
 * at specific historical dates.
 */
export async function createCompletedTestRun(options: {
  composeVersionId: string;
  userId: string;
  createdAt: Date;
  startedAt: Date;
  completedAt: Date;
}): Promise<string> {
  const orgId = await getOrgIdFromVersion(options.composeVersionId);

  const [row] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: options.userId,
      orgId,
      agentComposeVersionId: options.composeVersionId,
      status: "completed",
      prompt: "test",
      createdAt: options.createdAt,
      startedAt: options.startedAt,
      completedAt: options.completedAt,
    })
    .returning({ id: agentRuns.id });
  return row!.id;
}

/**
 * Insert a stale pending run directly into the database.
 * This simulates a run stuck in "pending" state past the cleanup TTL,
 * which cannot be reproduced through normal API flows since the route
 * handler immediately transitions runs to "running" or "failed".
 *
 * @param userId - The user ID who owns the run
 * @param agentComposeVersionId - The compose version ID
 * @param ageMs - How old the run should be in milliseconds (default: 20 minutes)
 * @returns The inserted run ID
 */
export async function insertStalePendingRun(
  userId: string,
  agentComposeVersionId: string,
  ageMs: number = 20 * 60 * 1000,
): Promise<string> {
  const orgId = await getOrgIdFromVersion(agentComposeVersionId);

  const staleCreatedAt = new Date(Date.now() - ageMs);
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId,
      status: "pending",
      prompt: "Stale pending run",
      createdAt: staleCreatedAt,
      lastHeartbeatAt: staleCreatedAt,
    })
    .returning({ id: agentRuns.id });

  if (!run) {
    throw new Error("Failed to insert stale pending run");
  }

  return run.id;
}

export async function markRunningRunsAsCompleted(userId: string) {
  await globalThis.services.db
    .update(agentRuns)
    .set({ status: "completed", completedAt: new Date() })
    .where(
      and(
        eq(agentRuns.userId, userId),
        or(eq(agentRuns.status, "running"), eq(agentRuns.status, "pending")),
      ),
    );
}

export async function setTestRunStatus(
  runId: string,
  status: string,
): Promise<void> {
  await globalThis.services.db
    .update(agentRuns)
    .set({
      status,
      ...(["completed", "failed", "timeout", "cancelled"].includes(status)
        ? { completedAt: new Date() }
        : {}),
    })
    .where(eq(agentRuns.id, runId));
}

export async function setTestRunModelProvider(
  runId: string,
  modelProvider: string,
): Promise<void> {
  await globalThis.services.db
    .update(zeroRuns)
    .set({ modelProvider })
    .where(eq(zeroRuns.id, runId));
}

export async function setTestRunSelectedModel(
  runId: string,
  selectedModel: string,
): Promise<void> {
  await globalThis.services.db
    .update(zeroRuns)
    .set({ selectedModel })
    .where(eq(zeroRuns.id, runId));
}

/**
 * Find agent runs matching a given userId and prompt.
 */
export async function findTestRunsByUserAndPrompt(
  userId: string,
  prompt: string,
) {
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
  const [row] = await globalThis.services.db
    .select()
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row;
}

/**
 * Insert a zero_runs record for a run that already exists in agent_runs.
 * Used in tests where the run is created via enqueueRun() (which does not
 * create a zero_runs row) and the test needs to set model provider metadata
 * for credit-check scenarios.
 */
export async function insertTestZeroRun(
  runId: string,
  options?: {
    triggerSource?: string;
    modelProvider?: string | null;
    selectedModel?: string | null;
  },
): Promise<void> {
  await globalThis.services.db.insert(zeroRuns).values({
    id: runId,
    triggerSource: options?.triggerSource ?? "cli",
    modelProvider: options?.modelProvider ?? null,
    selectedModel: options?.selectedModel ?? null,
  });
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
  return globalThis.services.db
    .select()
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
}

export async function findTestQueueEntry(runId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(agentRunQueue)
    .where(eq(agentRunQueue.runId, runId))
    .limit(1);
  return row;
}

export async function expireQueueEntry(runId: string) {
  // Set expiresAt far enough in the past to avoid any timing issues in CI
  await globalThis.services.db
    .update(agentRunQueue)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(agentRunQueue.runId, runId));
}

/**
 * Insert a queue entry for a run that is in "queued" status.
 * Looks up the run's userId and orgId from the agent_runs table.
 *
 * @param runId - The run ID to enqueue
 * @param options - Optional overrides for createdAt and expiresAt
 */
export async function insertTestQueueEntry(
  runId: string,
  options?: {
    createdAt?: Date;
    expiresAt?: Date;
  },
) {
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }
  await globalThis.services.db.insert(agentRunQueue).values({
    runId,
    userId: run.userId,
    orgId: run.orgId,
    createdAt: options?.createdAt,
    expiresAt: options?.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
  });
}

/**
 * Create a test callback record for agent run completion
 * Returns the callback ID and the plaintext secret for signing test requests
 */
export async function createTestCallback(params: {
  runId: string;
  url: string;
  payload?: Record<string, unknown>;
}): Promise<{ callbackId: string; secret: string }> {
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const secret = generateCallbackSecret();
  const encryptedSecret = encryptSecretValue(secret, SECRETS_ENCRYPTION_KEY);

  const [callback] = await globalThis.services.db
    .insert(agentRunCallbacks)
    .values({
      runId: params.runId,
      url: params.url,
      encryptedSecret,
      payload: params.payload ?? null,
    })
    .returning({ id: agentRunCallbacks.id });

  return { callbackId: callback!.id, secret };
}

/**
 * Find all callback records for a given run ID.
 */
export async function findTestCallbacksByRunId(runId: string) {
  return globalThis.services.db
    .select()
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
}

/**
 * Link an existing run to a schedule by setting its scheduleId.
 */
export async function linkRunToSchedule(
  runId: string,
  scheduleId: string,
): Promise<void> {
  await globalThis.services.db
    .update(zeroRuns)
    .set({ scheduleId })
    .where(eq(zeroRuns.id, runId));
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
    .limit(1);
  return row;
}

/**
 * Insert a test conversation record.
 */
export async function insertTestConversation(params: {
  runId: string;
}): Promise<void> {
  await globalThis.services.db.insert(conversations).values({
    runId: params.runId,
    cliAgentType: "claude-code",
    cliAgentSessionId: uniqueId("session"),
  });
}

/**
 * Enqueue a run for testing (test helper wrapping enqueueRun).
 */
export async function enqueueTestRun(params: {
  userId: string;
  agentComposeVersionId: string;
  orgId: string;
  prompt: string;
}): Promise<{ runId: string; status: string; queuedAt: Date }> {
  const result = await enqueueRun(params);
  return {
    runId: result.runId,
    status: result.status,
    queuedAt: result.createdAt,
  };
}

/**
 * Insert sandbox telemetry record for testing.
 */
export async function insertTestSandboxTelemetry(params: {
  runId: string;
}): Promise<{ id: string }> {
  const [record] = await globalThis.services.db
    .insert(sandboxTelemetry)
    .values({
      runId: params.runId,
      data: { systemLog: "test log", metrics: [] },
    })
    .returning({ id: sandboxTelemetry.id });

  return { id: record!.id };
}

/**
 * Find sandbox telemetry record by run ID.
 */
export async function findTestSandboxTelemetry(
  runId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await globalThis.services.db
    .select({ id: sandboxTelemetry.id })
    .from(sandboxTelemetry)
    .where(eq(sandboxTelemetry.runId, runId))
    .limit(1);
  return row;
}

/**
 * Insert a test usage_daily record.
 */
export async function insertTestUsageDaily(params: {
  userId: string;
  orgId: string;
  date: string;
}): Promise<void> {
  await globalThis.services.db.insert(usageDaily).values({
    userId: params.userId,
    orgId: params.orgId,
    date: params.date,
    runCount: 5,
  });
}
