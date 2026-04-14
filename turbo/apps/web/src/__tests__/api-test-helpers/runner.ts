import { eq } from "drizzle-orm";
import type { StoredExecutionContext } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import { runnerJobQueue } from "../../db/schema/runner-job-queue";
import { runnerState } from "../../db/schema/runner-state";
import { agentRuns } from "../../db/schema/agent-run";
import { encryptSecretsMap } from "../../lib/shared/crypto/secrets-encryption";
import { getOrgIdFromVersion } from "../db-test-seeders/runs";

/**
 * Create a runner job queue entry with an associated agent run.
 *
 * @param userId - The user who owns the run
 * @param versionId - The agent compose version ID
 * @param runnerGroup - The runner group (e.g., "org-slug/default")
 * @param contextOverrides - Optional overrides for the stored execution context
 * @param runOverrides - Optional overrides for the agent run record (e.g., appendSystemPrompt)
 * @returns The created run ID
 */
export async function createTestRunnerJob(
  userId: string,
  versionId: string,
  runnerGroup: string,
  contextOverrides?: Partial<StoredExecutionContext>,
  runOverrides?: { appendSystemPrompt?: string; sessionId?: string },
): Promise<{ runId: string }> {
  const orgId = await getOrgIdFromVersion(versionId);

  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      status: "pending",
      prompt: "test prompt",
      ...runOverrides,
    })
    .returning({ id: agentRuns.id });

  const encryptedSecrets = encryptSecretsMap(
    null,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );

  const storedContext: StoredExecutionContext = {
    workingDir: "/home/user",
    storageManifest: null,
    environment: null,
    resumeSession: null,
    encryptedSecrets,
    cliAgentType: "claude",
    ...contextOverrides,
  };

  await globalThis.services.db.insert(runnerJobQueue).values({
    runId: run!.id,
    runnerGroup,
    sessionId: runOverrides?.sessionId ?? null,
    executionContext: storedContext,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
  });

  return { runId: run!.id };
}

export async function findTestRunnerJobEntry(runId: string) {
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

export async function insertTestRunnerState(overrides: {
  runnerId: string;
  runnerGroup: string;
  runnerName?: string;
  profiles?: string[];
  maxConcurrent?: number;
  runningCount?: number;
  heldSessions?: string[];
  mode?: string;
  lastSeenAt?: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(runnerState).values({
    runnerId: overrides.runnerId,
    runnerName:
      overrides.runnerName ?? `runner-${overrides.runnerId.slice(0, 8)}`,
    runnerGroup: overrides.runnerGroup,
    profiles: overrides.profiles ?? ["vm0/default"],
    totalVcpu: 16,
    totalMemoryMb: 32768,
    maxConcurrent: overrides.maxConcurrent ?? 8,
    allocatedVcpu: 0,
    allocatedMemoryMb: 0,
    runningCount: overrides.runningCount ?? 0,
    heldSessions: overrides.heldSessions ?? [],
    mode: overrides.mode ?? "running",
    lastSeenAt: overrides.lastSeenAt ?? new Date(),
  });
}

export async function deleteAllTestRunnerState(): Promise<void> {
  initServices();
  await globalThis.services.db.delete(runnerState);
}
