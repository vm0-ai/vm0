import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookCompleteContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { checkpoints } from "../../../../../src/db/schema/checkpoint";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { eq, and } from "drizzle-orm";
import {
  transitionRunStatus,
  dispatchTerminalSideEffects,
} from "../../../../../src/lib/infra/run/run-status";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import type {
  ArtifactSnapshot,
  MemorySnapshot,
} from "../../../../../src/lib/infra/checkpoint";
import type { RunResult } from "../../../../../src/lib/infra/run/types";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  drainOrgQueue,
  dispatchQueuedZeroRun,
} from "../../../../../src/lib/zero/zero-run-queue-service";
import { processOrgCredits } from "../../../../../src/lib/zero/credit/credit-service";
import { updateAssistantMessageByRunId } from "../../../../../src/lib/zero/chat-thread/chat-message-service";
import { publishUserSignal } from "../../../../../src/lib/infra/realtime/client";
import { getOrgMemberUserIds } from "../../../../../src/lib/infra/realtime/audience";
import { after } from "next/server";
import { env } from "../../../../../src/env";

const log = logger("webhook:complete");

/**
 * Schedule terminal side effects in a non-blocking after() block.
 */
function scheduleTerminalSideEffects(
  runId: string,
  status: "completed" | "failed",
  orgId: string,
  userId: string,
  errorMsg?: string,
): void {
  after(async () => {
    await dispatchTerminalSideEffects(runId, status, errorMsg, () => {
      return drainOrgQueue(orgId, dispatchQueuedZeroRun);
    });
    await processOrgCredits(orgId);

    // Notify run owner that run state changed
    await publishUserSignal([userId], `thread:${runId}`);
    await publishUserSignal([userId], `runUpdated:${runId}`);
    // Notify org members that task list may have changed
    const orgMembers = await getOrgMemberUserIds(orgId);
    await publishUserSignal(orgMembers, `tasks:${orgId}`);
  });
}

/**
 * Build a RunResult from a checkpoint record.
 */
function buildRunResult(
  checkpoint: typeof checkpoints.$inferSelect,
  sessionId: string | undefined,
): RunResult {
  const artifactSnapshot =
    checkpoint.artifactSnapshot as ArtifactSnapshot | null;
  const memorySnapshot = checkpoint.memorySnapshot as MemorySnapshot | null;
  const volumeVersions = checkpoint.volumeVersionsSnapshot as
    | { versions: Record<string, string> }
    | undefined;

  const result: RunResult = {
    checkpointId: checkpoint.id,
    agentSessionId: sessionId ?? checkpoint.conversationId,
    conversationId: checkpoint.conversationId,
    volumes: volumeVersions?.versions,
  };

  if (artifactSnapshot) {
    result.artifact = {
      [artifactSnapshot.artifactName]: artifactSnapshot.artifactVersion,
    };
  }

  if (memorySnapshot) {
    result.memory = {
      [memorySnapshot.memoryName]: memorySnapshot.memoryVersion,
    };
  }

  return result;
}

const router = tsr.router(webhookCompleteContract, {
  complete: async ({ body, headers }) => {
    initServices();

    // Authenticate with sandbox JWT and verify runId matches
    const auth = getSandboxAuthForRun(body.runId, headers.authorization);
    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Not authenticated or runId mismatch",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    const { userId } = auth;

    log.debug(
      `Received completion for run ${body.runId}, exitCode=${body.exitCode}`,
    );

    // Get run record
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Idempotency check: if run is already completed/failed, return early
    if (run.status === "completed" || run.status === "failed") {
      log.debug(
        `Run ${body.runId} already ${run.status}, skipping duplicate completion`,
      );
      return {
        status: 200 as const,
        body: {
          success: true,
          status: run.status as "completed" | "failed",
        },
      };
    }

    let finalStatus: "completed" | "failed";
    let errorMessage: string | undefined;

    if (body.exitCode === 0) {
      // Success: query checkpoint and store result in run table
      const [checkpoint] = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, body.runId))
        .limit(1);

      if (!checkpoint) {
        const transitioned = await transitionRunStatus(
          body.runId,
          {
            status: "failed",
            completedAt: new Date(),
            error: "Checkpoint for run not found",
          },
          ["pending", "running", "timeout"],
        );

        // Dispatch callbacks so the user gets notified about the failure
        // (previously this path returned without dispatching)
        if (transitioned) {
          scheduleTerminalSideEffects(
            body.runId,
            "failed",
            run.orgId,
            userId,
            "Checkpoint for run not found",
          );
        }

        return {
          status: 404 as const,
          body: {
            error: {
              message: "Checkpoint for run not found",
              code: "NOT_FOUND",
            },
          },
        };
      }

      // Get agent session for the conversation
      const [session] = await globalThis.services.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.conversationId, checkpoint.conversationId))
        .limit(1);

      const result = buildRunResult(checkpoint, session?.id);

      // Atomically transition to "completed". Also accept "timeout" so a
      // sandbox that eventually reports success after a heartbeat-timeout
      // sweep can still upgrade the run state.
      const transitioned = await transitionRunStatus(
        body.runId,
        {
          status: "completed",
          completedAt: new Date(),
          result,
        },
        ["pending", "running", "timeout"],
      );

      if (!transitioned) {
        log.debug(
          `Run ${body.runId} already transitioned, skipping duplicate completion`,
        );
        return {
          status: 200 as const,
          body: { success: true, status: "completed" as const },
        };
      }

      // Upgrade path (rare): sandbox reports success after a prior heartbeat
      // timeout. The placeholder still carries "Run timed out..." content
      // that the cron's callback wrote — clear it so the UI falls back to
      // the event-backed assistant rows (if any).
      if (run.status === "timeout") {
        await updateAssistantMessageByRunId(body.runId, null, undefined);
      }

      finalStatus = "completed";
      log.debug(`Run ${body.runId} completed successfully`);
    } else {
      // Failure: store error in run table
      const reportUrl = `${env().NEXT_PUBLIC_APP_URL}/runs/${body.runId}/report-error`;
      errorMessage = `An unexpected error occurred. [Report this issue](${reportUrl})`;

      // Also accept "timeout" so the sandbox's own exit-code-based error
      // (with the report-error link) supersedes a stale "Run timed out
      // (no heartbeat)" stamped earlier by the cleanup cron.
      const transitioned = await transitionRunStatus(
        body.runId,
        {
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
        },
        ["pending", "running", "timeout"],
      );

      if (!transitioned) {
        log.debug(
          `Run ${body.runId} already transitioned, skipping duplicate failure`,
        );
        return {
          status: 200 as const,
          body: { success: true, status: "failed" as const },
        };
      }

      // Upgrade path: if the cron already stamped this run as timeout and
      // fired its chat callback, the placeholder's content/error still
      // carries "Run timed out (no heartbeat)". Refresh it with the
      // sandbox-reported error so the user sees the report-error link
      // instead of the generic timeout message. No-op for non-chat runs.
      if (run.status === "timeout") {
        await updateAssistantMessageByRunId(
          body.runId,
          errorMessage,
          errorMessage,
        );
      }

      finalStatus = "failed";
      log.warn(`Run ${body.runId} failed: ${errorMessage}`);
    }

    // Dispatch all registered callbacks and drain run queue (non-blocking)
    scheduleTerminalSideEffects(
      body.runId,
      finalStatus,
      run.orgId,
      userId,
      errorMessage,
    );

    return {
      status: 200 as const,
      body: {
        success: true,
        status: finalStatus,
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(webhookCompleteContract, router, {
  errorHandler,
});

export { handler as POST };
