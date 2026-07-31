import { command } from "ccstate";
import type { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { RunResult, RunStatus } from "@vm0/api-contracts/contracts/runs";
import { webhookCompleteContract } from "@vm0/api-contracts/contracts/webhooks";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
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
        readonly status: TerminalStatus;
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
    return await handleMissingCheckpoint(db, input, run, signal);
  }

  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, checkpoint.conversationId))
    .limit(1);
  signal.throwIfAborted();

  const result = buildRunResult(checkpoint, session?.id);
  const completedAt = nowDate();
  const transitioned = await transitionRunStatus(
    db,
    input.body.runId,
    {
      status: "completed",
      completedAt,
      result,
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
