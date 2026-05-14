import { command } from "ccstate";
import type { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { RunResult, RunStatus } from "@vm0/api-contracts/contracts/runs";
import { webhookCompleteContract } from "@vm0/api-contracts/contracts/webhooks";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { checkpoints } from "@vm0/db/schema/checkpoint";

import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import { publishRunChangedForUserSafely } from "../external/realtime";
import { dispatchRunCallbacks } from "./agent-run-callback.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";
import { drainOrgQueue$ } from "./zero-run-queue.service";

type WebhookCompleteBody = z.infer<
  typeof webhookCompleteContract.complete.body
>;
type TerminalStatus = "completed" | "failed";

interface CompleteAgentRunInput {
  readonly auth: SandboxAuth;
  readonly body: WebhookCompleteBody;
}

interface TerminalSideEffectsInput {
  readonly runId: string;
  readonly orgId: string;
  readonly status: TerminalStatus;
  readonly error?: string;
}

interface CompletionResponse {
  readonly status: 200 | 404;
  readonly body:
    | {
        readonly success: true;
        readonly status: TerminalStatus;
      }
    | {
        readonly error: {
          readonly message: string;
          readonly code: "NOT_FOUND";
        };
      };
  readonly sideEffects?: TerminalSideEffectsInput;
}

interface VolumeVersionsSnapshot {
  readonly versions: Record<string, string>;
}

interface RunRecord {
  readonly orgId: string;
  readonly status: string;
  readonly userId: string;
}

interface ArtifactSnapshot {
  readonly name: string;
  readonly version: string;
  readonly mountPath: string;
}

const L = logger("webhook:complete");

function isVolumeVersionsSnapshot(
  value: unknown,
): value is VolumeVersionsSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "versions" in value &&
    typeof value.versions === "object" &&
    value.versions !== null &&
    !Array.isArray(value.versions) &&
    Object.values(value.versions).every((entry) => {
      return typeof entry === "string";
    })
  );
}

function isArtifactSnapshot(value: unknown): value is ArtifactSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "version" in value &&
    "mountPath" in value &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.mountPath === "string"
  );
}

function decodeArtifactSnapshotsToRecord(
  raw: unknown,
): Record<string, string> | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [index, entry] of raw.entries()) {
    if (!isArtifactSnapshot(entry)) {
      throw new Error(`Invalid checkpoint artifact snapshot at index ${index}`);
    }
    result[entry.name] = entry.version;
  }
  return result;
}

function buildRunResult(
  checkpoint: typeof checkpoints.$inferSelect,
  sessionId: string | undefined,
): RunResult {
  const artifact = decodeArtifactSnapshotsToRecord(
    checkpoint.artifactSnapshots,
  );
  const volumeVersions = isVolumeVersionsSnapshot(
    checkpoint.volumeVersionsSnapshot,
  )
    ? checkpoint.volumeVersionsSnapshot.versions
    : undefined;

  return {
    checkpointId: checkpoint.id,
    agentSessionId: sessionId ?? checkpoint.conversationId,
    conversationId: checkpoint.conversationId,
    ...(artifact ? { artifact } : {}),
    ...(volumeVersions ? { volumes: volumeVersions } : {}),
  };
}

async function persistLastEventSequence(
  db: Db,
  runId: string,
  userId: string,
  lastEventSequence: number,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      lastEventSequence: sql<number>`greatest(coalesce(${agentRuns.lastEventSequence}, -1), ${lastEventSequence})`,
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));
}

async function readCompletionResponseStatus(
  db: Db,
  runId: string,
  userId: string,
): Promise<TerminalStatus> {
  const [currentRun] = await db
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
    .limit(1);

  return currentRun?.status === "completed" ? "completed" : "failed";
}

async function transitionRunStatus(
  db: Db,
  runId: string,
  update: {
    readonly status: RunStatus;
    readonly completedAt: Date;
    readonly error?: string;
    readonly result?: RunResult;
    readonly sandboxId?: string;
    readonly sandboxReuseResult?: WebhookCompleteBody["sandboxReuseResult"];
  },
  allowedFromStatuses: readonly RunStatus[],
): Promise<boolean> {
  const [updated] = await db
    .update(agentRuns)
    .set(update)
    .where(
      and(
        eq(agentRuns.id, runId),
        inArray(agentRuns.status, [...allowedFromStatuses]),
      ),
    )
    .returning({ id: agentRuns.id });
  return !!updated;
}

function successResponse(
  runId: string,
  orgId: string,
  status: TerminalStatus,
  error?: string,
): CompletionResponse {
  return {
    status: 200,
    body: {
      success: true,
      status,
    },
    sideEffects: {
      runId,
      orgId,
      status,
      ...(error ? { error } : {}),
    },
  };
}

async function currentStatusResponse(
  db: Db,
  input: CompleteAgentRunInput,
): Promise<CompletionResponse> {
  return {
    status: 200,
    body: {
      success: true,
      status: await readCompletionResponseStatus(
        db,
        input.body.runId,
        input.auth.userId,
      ),
    },
  };
}

async function handleMissingCheckpoint(
  db: Db,
  input: CompleteAgentRunInput,
  run: RunRecord,
  signal: AbortSignal,
): Promise<CompletionResponse> {
  const error = "Checkpoint for run not found";
  const transitioned = await transitionRunStatus(
    db,
    input.body.runId,
    {
      status: "failed",
      completedAt: nowDate(),
      error,
      sandboxId: input.body.sandboxId,
      sandboxReuseResult: input.body.sandboxReuseResult,
    },
    ["pending", "running", "timeout"],
  );
  signal.throwIfAborted();

  if (!transitioned) {
    return await currentStatusResponse(db, input);
  }

  await publishRunChangedForUserSafely(run.userId, input.body.runId, {
    status: "failed",
  });
  signal.throwIfAborted();

  return {
    status: 404,
    body: {
      error: {
        message: error,
        code: "NOT_FOUND",
      },
    },
    sideEffects: {
      runId: input.body.runId,
      orgId: run.orgId,
      status: "failed",
      error,
    },
  };
}

async function handleSuccessfulCompletion(
  db: Db,
  input: CompleteAgentRunInput,
  run: RunRecord,
  signal: AbortSignal,
): Promise<CompletionResponse> {
  const [checkpoint] = await db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.runId, input.body.runId))
    .limit(1);
  signal.throwIfAborted();

  if (!checkpoint) {
    return await handleMissingCheckpoint(db, input, run, signal);
  }

  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, checkpoint.conversationId))
    .limit(1);
  signal.throwIfAborted();

  const result = buildRunResult(checkpoint, session?.id);
  const transitioned = await transitionRunStatus(
    db,
    input.body.runId,
    {
      status: "completed",
      completedAt: nowDate(),
      result,
      sandboxId: input.body.sandboxId,
      sandboxReuseResult: input.body.sandboxReuseResult,
    },
    ["pending", "running", "timeout"],
  );
  signal.throwIfAborted();

  if (!transitioned) {
    return await currentStatusResponse(db, input);
  }

  await publishRunChangedForUserSafely(run.userId, input.body.runId, {
    status: "completed",
  });
  signal.throwIfAborted();

  L.debug("Run completed successfully", { runId: input.body.runId });
  return successResponse(input.body.runId, run.orgId, "completed");
}

async function handleFailedCompletion(
  db: Db,
  input: CompleteAgentRunInput,
  run: RunRecord,
  signal: AbortSignal,
): Promise<CompletionResponse> {
  const error = input.body.error?.trim() || "Run failed without error message";
  const transitioned = await transitionRunStatus(
    db,
    input.body.runId,
    {
      status: "failed",
      completedAt: nowDate(),
      error,
      sandboxId: input.body.sandboxId,
      sandboxReuseResult: input.body.sandboxReuseResult,
    },
    ["pending", "running", "timeout"],
  );
  signal.throwIfAborted();

  if (!transitioned) {
    return await currentStatusResponse(db, input);
  }

  await publishRunChangedForUserSafely(run.userId, input.body.runId, {
    status: "failed",
  });
  signal.throwIfAborted();

  L.warn("Run failed", {
    runId: input.body.runId,
    exitCode: input.body.exitCode,
    error,
  });
  return successResponse(input.body.runId, run.orgId, "failed", error);
}

export const dispatchCompleteSideEffects$ = command(
  async (
    { set },
    input: TerminalSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const callbackStatus =
      input.status === "completed" ? "completed" : "failed";
    await dispatchRunCallbacks(
      db,
      input.runId,
      callbackStatus,
      undefined,
      input.error,
    ).catch((error: unknown) => {
      L.error("Failed to dispatch terminal callbacks", {
        runId: input.runId,
        error,
      });
    });
    signal.throwIfAborted();

    await set(drainOrgQueue$, { orgId: input.orgId }, signal).catch(
      (error: unknown) => {
        L.error("Failed to drain org queue", {
          runId: input.runId,
          orgId: input.orgId,
          error,
        });
      },
    );
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, input.orgId, signal);
    signal.throwIfAborted();
  },
);

export const completeAgentRun$ = command(
  async (
    { set },
    input: CompleteAgentRunInput,
    signal: AbortSignal,
  ): Promise<CompletionResponse> => {
    const db = set(writeDb$);
    const [run] = await db
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        status: agentRuns.status,
        userId: agentRuns.userId,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, input.body.runId),
          eq(agentRuns.userId, input.auth.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!run) {
      return notFound("Agent run not found");
    }

    if (input.body.lastEventSequence !== undefined) {
      await persistLastEventSequence(
        db,
        input.body.runId,
        input.auth.userId,
        input.body.lastEventSequence,
      );
      signal.throwIfAborted();
    }

    if (run.status === "completed" || run.status === "failed") {
      L.debug("Skipping duplicate completion for terminal run", {
        runId: input.body.runId,
        status: run.status,
      });
      return {
        status: 200,
        body: {
          success: true,
          status: run.status,
        },
      };
    }

    if (input.body.exitCode === 0) {
      return await handleSuccessfulCompletion(db, input, run, signal);
    }

    return await handleFailedCompletion(db, input, run, signal);
  },
);
