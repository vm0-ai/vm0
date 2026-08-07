import { command } from "ccstate";
import type { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { PI_STANDBY_TTL_RELEASE_EXIT_CODE } from "@vm0/api-contracts/contracts/runners";
import type { RunResult, RunStatus } from "@vm0/api-contracts/contracts/runs";
import { webhookCompleteContract } from "@vm0/api-contracts/contracts/webhooks";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { piThreadMessages } from "@vm0/db/schema/pi-thread-message";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  parsePiAgentMessages,
  piMessageRequiresSandbox,
} from "@vm0/pi-agent-runtime";

import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import type { SandboxAuth } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  publishChatThreadDetailChangedSafely,
  publishPiHandoffToRunnerGroupSafely,
  publishRunnerJobNotification,
  publishRunChangedForUserSafely,
} from "../external/realtime";
import { tapError } from "../utils";
import {
  chatCallbackIdForRun,
  dispatchFailedRunCallbacks,
  dispatchRunCallbacks$,
} from "./agent-run-callback.service";
import { drainChatThreadQueueForRun$ } from "./chat-thread-queue-drain.service";
import { projectLegacyCheckpointStorage } from "./storage-legacy-projection.service";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";
import { maybeEmitRunUsageEvent$ } from "./zero-chat-usage-event.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";
import { drainOrgQueue$ } from "./zero-run-queue.service";

type WebhookCompleteBody = z.infer<
  typeof webhookCompleteContract.complete.body
>;
type TerminalStatus = "completed" | "failed";

interface CompleteAgentRunInput {
  readonly auth: SandboxAuth;
  readonly body: WebhookCompleteBody;
  readonly allowCheckpointlessSuccess?: boolean;
}

interface TerminalSideEffectsInput {
  readonly kind: "terminal";
  readonly runId: string;
  readonly orgId: string;
  readonly status: TerminalStatus;
  readonly error?: string;
}

interface CancellationRecoverySideEffectsInput {
  readonly kind: "cancellation-recovery";
  readonly runId: string;
  readonly userId: string;
  readonly chatThreadId: string | null;
}

type CompleteSideEffectsInput =
  | TerminalSideEffectsInput
  | CancellationRecoverySideEffectsInput;

type DispatchCompleteSideEffectsInput = CompleteSideEffectsInput & {
  readonly apiStartTime?: number;
};

interface CompletionResponse {
  readonly status: 200 | 404;
  readonly body:
    | {
        readonly success: true;
        readonly status: TerminalStatus | "released";
      }
    | {
        readonly error: {
          readonly message: string;
          readonly code: "NOT_FOUND";
        };
      };
  readonly sideEffects?: CompleteSideEffectsInput;
}

interface RunRecord {
  readonly cancellationRecoveryCompleted: boolean | null;
  readonly orgId: string;
  readonly status: string;
  readonly userId: string;
  readonly chatThreadId: string | null;
}

const L = logger("webhook:complete");

function buildRunResult(
  checkpoint: Pick<
    typeof checkpoints.$inferSelect,
    "id" | "conversationId" | "storageMounts"
  >,
  sessionId: string | undefined,
): RunResult {
  if (checkpoint.storageMounts === null) {
    throw new Error(
      `Checkpoint "${checkpoint.id}" is missing canonical Storage mounts`,
    );
  }
  const canonicalProjection = projectLegacyCheckpointStorage(
    checkpoint.storageMounts,
  );
  const artifact = canonicalProjection.artifactVersions ?? undefined;
  const volumeVersions =
    canonicalProjection.volumeVersionsSnapshot?.versions ?? undefined;

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
      lastEventSequence: sql`greatest(coalesce(${agentRuns.lastEventSequence}, -1), ${lastEventSequence})`,
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));
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
  if (!updated) {
    return false;
  }
  // Pi jobs can stay in the queue after a standby claim or while cold-start
  // handoff data is still being persisted. Nothing consumes them once the run
  // settles. Ordinary rows are already removed by the normal claim/expiry
  // lifecycle, and deleting those rows here would change stale-claim errors.
  await db.delete(runnerJobQueue).where(
    and(
      eq(runnerJobQueue.runId, runId),
      sql`${runnerJobQueue.executionContext}->>'piExecutionMode'
          IN ('standby', 'cold-start')`,
    ),
  );
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "run_terminal_transition_committed",
    durationMs: 0,
    success: true,
    runId,
  });
  return true;
}

async function hasPersistedPiSandboxHandoff(
  db: Pick<Db, "select">,
  runId: string,
): Promise<boolean> {
  const messages = await db
    .select({ payload: piThreadMessages.payload })
    .from(piThreadMessages)
    .where(eq(piThreadMessages.runId, runId));
  return parsePiAgentMessages(
    messages.map(({ payload }) => {
      return payload;
    }),
  ).some(piMessageRequiresSandbox);
}

function resetRunForPiColdStart() {
  return {
    status: "pending" as const,
    startedAt: null,
    lastHeartbeatAt: null,
    runnerId: null,
    runnerHeartbeatGeneration: null,
    cancellationRecoveryCompleted: null,
  };
}

async function tryReleasePiStandbyForColdStart(
  db: Db,
  input: CompleteAgentRunInput,
  signal: AbortSignal,
): Promise<boolean> {
  const requeued = await db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: agentRuns.id,
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
      .for("update");
    signal.throwIfAborted();
    if (!run || run.status !== "running") {
      return null;
    }

    const [job] = await tx
      .select({
        profile: runnerJobQueue.profile,
        runnerGroup: runnerJobQueue.runnerGroup,
        piExecutionMode:
          sql`${runnerJobQueue.executionContext}->>'piExecutionMode'`.mapWith(
            nullableDriverValueDecoder(pgTextDecoder),
          ),
      })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, input.body.runId))
      .for("update");
    signal.throwIfAborted();
    if (!job || job.piExecutionMode !== "standby") {
      return null;
    }

    const coldStartReady = await hasPersistedPiSandboxHandoff(
      tx,
      input.body.runId,
    );
    const timestamps = runnerJobQueueTimestamps();
    await tx
      .update(runnerJobQueue)
      .set({
        executionContext: sql`jsonb_set(
          ${runnerJobQueue.executionContext},
          '{piExecutionMode}',
          to_jsonb(${"cold-start"}::text),
          true
        )`,
        createdAt: timestamps.createdAt,
        expiresAt: timestamps.expiresAt,
      })
      .where(eq(runnerJobQueue.runId, input.body.runId));
    if (coldStartReady) {
      await tx
        .update(agentRuns)
        .set(resetRunForPiColdStart())
        .where(
          and(
            eq(agentRuns.id, input.body.runId),
            eq(agentRuns.status, "running"),
          ),
        );
    }
    signal.throwIfAborted();
    return {
      coldStartReady,
      profile: job.profile,
      runnerGroup: job.runnerGroup,
      userId: run.userId,
    };
  });
  signal.throwIfAborted();
  if (!requeued) {
    return false;
  }

  recordSandboxOperation({
    sandboxType: "runner",
    actionType: `${
      input.body.exitCode === PI_STANDBY_TTL_RELEASE_EXIT_CODE
        ? "pi_standby_ttl"
        : "pi_standby_failure"
    }_${requeued.coldStartReady ? "cold_start_fallback" : "cold_start_deferred"}`,
    durationMs: 0,
    success: true,
    runId: input.body.runId,
  });
  if (requeued.coldStartReady) {
    await publishRunChangedForUserSafely(requeued.userId, input.body.runId, {
      status: "pending",
    });
    signal.throwIfAborted();
    await publishRunnerJobNotification({
      group: requeued.runnerGroup,
      runId: input.body.runId,
      profile: requeued.profile,
      piExecutionMode: "cold-start",
      runnerPreference: {
        kind: "noPreference",
        reason: "noReuseKey",
      },
    });
    signal.throwIfAborted();
  }
  return true;
}

const activatePiColdStartForHandoff$ = command(
  async (
    { set },
    input: { readonly runId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const activation = await db.transaction(async (tx) => {
      const [run] = await tx
        .select({ status: agentRuns.status, userId: agentRuns.userId })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.userId, input.userId),
          ),
        )
        .for("update");
      signal.throwIfAborted();
      if (!run || (run.status !== "running" && run.status !== "pending")) {
        return null;
      }
      const [job] = await tx
        .select({
          profile: runnerJobQueue.profile,
          runnerGroup: runnerJobQueue.runnerGroup,
          piExecutionMode:
            sql`${runnerJobQueue.executionContext}->>'piExecutionMode'`.mapWith(
              nullableDriverValueDecoder(pgTextDecoder),
            ),
        })
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, input.runId))
        .for("update");
      signal.throwIfAborted();
      if (!job || job.piExecutionMode !== "cold-start") {
        return null;
      }
      if (run.status === "pending") {
        return {
          notify: false,
          profile: job.profile,
          runnerGroup: job.runnerGroup,
          userId: run.userId,
        };
      }
      const timestamps = runnerJobQueueTimestamps();
      await tx
        .update(runnerJobQueue)
        .set({
          createdAt: timestamps.createdAt,
          expiresAt: timestamps.expiresAt,
        })
        .where(eq(runnerJobQueue.runId, input.runId));
      await tx
        .update(agentRuns)
        .set(resetRunForPiColdStart())
        .where(
          and(eq(agentRuns.id, input.runId), eq(agentRuns.status, "running")),
        );
      signal.throwIfAborted();
      return {
        notify: true,
        profile: job.profile,
        runnerGroup: job.runnerGroup,
        userId: run.userId,
      };
    });
    signal.throwIfAborted();
    if (!activation) {
      return false;
    }
    if (activation.notify) {
      recordSandboxOperation({
        sandboxType: "runner",
        actionType: "pi_cold_start_handoff_activated",
        durationMs: 0,
        success: true,
        runId: input.runId,
      });
      await publishRunChangedForUserSafely(activation.userId, input.runId, {
        status: "pending",
      });
      signal.throwIfAborted();
      await publishRunnerJobNotification({
        group: activation.runnerGroup,
        runId: input.runId,
        profile: activation.profile,
        piExecutionMode: "cold-start",
        runnerPreference: {
          kind: "noPreference",
          reason: "noReuseKey",
        },
      });
      signal.throwIfAborted();
    }
    return true;
  },
);

export const dispatchPiSandboxHandoff$ = command(
  async (
    { set },
    input: {
      readonly runId: string;
      readonly userId: string;
      readonly runnerGroup: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const coldStartActive = await set(
      activatePiColdStartForHandoff$,
      { runId: input.runId, userId: input.userId },
      signal,
    );
    if (!coldStartActive) {
      await publishPiHandoffToRunnerGroupSafely(input.runnerGroup, input.runId);
    }
  },
);

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
      kind: "terminal",
      runId,
      orgId,
      status,
      ...(error ? { error } : {}),
    },
  };
}

async function handleLostTerminalTransition(
  db: Db,
  input: CompleteAgentRunInput,
  signal: AbortSignal,
): Promise<CompletionResponse> {
  const [currentRun] = await db
    .select({
      orgId: agentRuns.orgId,
      status: agentRuns.status,
      userId: agentRuns.userId,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(agentRuns.id, input.body.runId),
        eq(agentRuns.userId, input.auth.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (currentRun?.status === "cancelled") {
    return await handleCancelledCompletion(db, input, currentRun, signal);
  }

  return {
    status: 200,
    body: {
      success: true,
      status: currentRun?.status === "completed" ? "completed" : "failed",
    },
  };
}

async function handleCancelledCompletion(
  db: Db,
  input: CompleteAgentRunInput,
  run: RunRecord,
  signal: AbortSignal,
): Promise<CompletionResponse> {
  if (run.cancellationRecoveryCompleted === false) {
    await db
      .update(agentRuns)
      .set({ cancellationRecoveryCompleted: true })
      .where(
        and(
          eq(agentRuns.id, input.body.runId),
          eq(agentRuns.userId, input.auth.userId),
          eq(agentRuns.status, "cancelled"),
          eq(agentRuns.cancellationRecoveryCompleted, false),
        ),
      );
    signal.throwIfAborted();
  }

  return {
    status: 200,
    body: {
      success: true,
      status: "failed",
    },
    ...(run.cancellationRecoveryCompleted !== null
      ? {
          sideEffects: {
            kind: "cancellation-recovery" as const,
            runId: input.body.runId,
            userId: run.userId,
            chatThreadId: run.chatThreadId,
          },
        }
      : {}),
  };
}

async function handleMissingCheckpoint(
  db: Db,
  input: CompleteAgentRunInput,
  run: RunRecord,
  signal: AbortSignal,
): Promise<CompletionResponse> {
  const error = "Checkpoint for run not found";
  const completedAt = nowDate();
  const transitioned = await transitionRunStatus(
    db,
    input.body.runId,
    {
      status: "failed",
      completedAt,
      error,
      sandboxId: input.body.sandboxId,
      sandboxReuseResult: input.body.sandboxReuseResult,
    },
    ["pending", "running", "timeout"],
  );
  signal.throwIfAborted();

  if (!transitioned) {
    return await handleLostTerminalTransition(db, input, signal);
  }

  await publishRunChangedForUserSafely(run.userId, input.body.runId, {
    status: "failed",
  });
  signal.throwIfAborted();

  L.warn("Run failed because checkpoint was not found", {
    runId: input.body.runId,
    error,
  });
  return successResponse(input.body.runId, run.orgId, "failed", error);
}

async function handleSuccessfulCompletion(
  db: Db,
  input: CompleteAgentRunInput,
  run: RunRecord,
  signal: AbortSignal,
): Promise<CompletionResponse> {
  const [checkpoint] = await db
    .select({
      id: checkpoints.id,
      conversationId: checkpoints.conversationId,
      storageMounts: checkpoints.storageMounts,
    })
    .from(checkpoints)
    .where(eq(checkpoints.runId, input.body.runId))
    .limit(1);
  signal.throwIfAborted();

  if (!checkpoint) {
    const allowCheckpointlessSuccess =
      input.allowCheckpointlessSuccess ||
      (await hasAcknowledgedTerminalPiMessage(db, input, signal));
    if (allowCheckpointlessSuccess) {
      return await persistSuccessfulCompletion(
        db,
        input,
        run,
        undefined,
        signal,
      );
    }
    return await handleMissingCheckpoint(db, input, run, signal);
  }

  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, checkpoint.conversationId))
    .limit(1);
  signal.throwIfAborted();

  const result = buildRunResult(checkpoint, session?.id);
  return await persistSuccessfulCompletion(db, input, run, result, signal);
}

async function hasAcknowledgedTerminalPiMessage(
  db: Db,
  input: CompleteAgentRunInput,
  signal: AbortSignal,
): Promise<boolean> {
  const lastEventSequence = input.body.lastEventSequence;
  if (lastEventSequence === undefined) {
    return false;
  }
  const [message] = await db
    .select({
      messageId: piThreadMessages.messageId,
      role: piThreadMessages.role,
      payload: piThreadMessages.payload,
      runEventSequenceNumber: piThreadMessages.runEventSequenceNumber,
    })
    .from(piThreadMessages)
    .where(eq(piThreadMessages.runId, input.body.runId))
    .orderBy(desc(piThreadMessages.runEventSequenceNumber))
    .limit(1);
  signal.throwIfAborted();

  const payload = message?.payload;
  return (
    message?.runEventSequenceNumber === lastEventSequence &&
    message.messageId === `${input.body.runId}/${lastEventSequence}` &&
    message.role === "assistant" &&
    payload !== undefined &&
    payload.role === "assistant" &&
    typeof payload.stopReason === "string" &&
    payload.stopReason !== "toolUse"
  );
}

async function persistSuccessfulCompletion(
  db: Db,
  input: CompleteAgentRunInput,
  run: RunRecord,
  result: RunResult | undefined,
  signal: AbortSignal,
): Promise<CompletionResponse> {
  const completedAt = nowDate();
  const transitioned = await transitionRunStatus(
    db,
    input.body.runId,
    {
      status: "completed",
      completedAt,
      ...(result ? { result } : {}),
      sandboxId: input.body.sandboxId,
      sandboxReuseResult: input.body.sandboxReuseResult,
    },
    ["pending", "running", "timeout"],
  );
  signal.throwIfAborted();

  if (!transitioned) {
    return await handleLostTerminalTransition(db, input, signal);
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
  const completedAt = nowDate();
  const transitioned = await transitionRunStatus(
    db,
    input.body.runId,
    {
      status: "failed",
      completedAt,
      error,
      sandboxId: input.body.sandboxId,
      sandboxReuseResult: input.body.sandboxReuseResult,
    },
    ["pending", "running", "timeout"],
  );
  signal.throwIfAborted();

  if (!transitioned) {
    return await handleLostTerminalTransition(db, input, signal);
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
    input: DispatchCompleteSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const apiStartTime = input.apiStartTime ?? now();
    if (input.kind === "cancellation-recovery") {
      if (input.chatThreadId !== null) {
        await publishChatThreadDetailChangedSafely(
          input.userId,
          input.chatThreadId,
        );
        signal.throwIfAborted();
      }
      await tapError(
        set(
          drainChatThreadQueueForRun$,
          {
            runId: input.runId,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            apiStartTime,
          },
          signal,
        ),
        (error) => {
          L.error("Failed to drain chat thread queue after recovery", {
            runId: input.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
      return;
    }

    const db = set(writeDb$);
    const callbackStatus =
      input.status === "completed" ? "completed" : "failed";
    const chatCallbackId = await chatCallbackIdForRun(db, input.runId);
    signal.throwIfAborted();
    const callbackResults = await tapError(
      set(
        dispatchRunCallbacks$,
        {
          db,
          runId: input.runId,
          status: callbackStatus,
          error: input.error,
        },
        signal,
      ),
      (error) => {
        L.error("Failed to dispatch terminal callbacks", {
          runId: input.runId,
          error,
        });
      },
    );
    signal.throwIfAborted();

    const chatCallbackDrained = callbackResults?.some((result) => {
      return result.callbackId === chatCallbackId && result.success;
    });
    if (!chatCallbackDrained) {
      await tapError(
        set(
          drainChatThreadQueueForRun$,
          {
            runId: input.runId,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            apiStartTime,
          },
          signal,
        ),
        (error) => {
          L.error("Failed to drain chat thread queue", {
            runId: input.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    await tapError(
      set(drainOrgQueue$, { orgId: input.orgId }, signal),
      (error) => {
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

    await tapError(
      set(maybeEmitRunUsageEvent$, input.runId, signal),
      (error) => {
        L.error("Failed to emit chat usage message after run completion", {
          runId: input.runId,
          orgId: input.orgId,
          error,
        });
      },
    );
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
        cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(agentRuns)
      .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
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

    if (
      input.body.exitCode !== 0 &&
      (await tryReleasePiStandbyForColdStart(db, input, signal))
    ) {
      return {
        status: 200,
        body: { success: true, status: "released" },
      };
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
          status: run.status === "completed" ? "completed" : "failed",
        },
      };
    }

    if (run.status === "cancelled") {
      return await handleCancelledCompletion(db, input, run, signal);
    }

    if (input.body.exitCode === 0) {
      return await handleSuccessfulCompletion(db, input, run, signal);
    }

    return await handleFailedCompletion(db, input, run, signal);
  },
);
