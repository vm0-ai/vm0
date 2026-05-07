import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookCompleteContract } from "@vm0/api-contracts/contracts/webhooks";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { eq, and } from "drizzle-orm";
import {
  transitionRunStatus,
  dispatchTerminalSideEffects,
} from "../../../../../src/lib/infra/run/run-status";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { decodeToRecord } from "../../../../../src/lib/infra/checkpoint/decode-artifact-snapshots";
import type { RunResult } from "../../../../../src/lib/infra/run/types";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  drainOrgQueue,
  dispatchQueuedZeroRun,
} from "../../../../../src/lib/zero/zero-run-queue-service";
import { processOrgUsageEvents } from "../../../../../src/lib/zero/credit/usage-event-service";
import { waitForAgentEventPrefixVisible } from "../../../../../src/lib/infra/run/agent-event-visibility";
import { publishRunChangedForUserSafely } from "../../../../../src/lib/infra/run/run-realtime";
import { after } from "next/server";

const log = logger("webhook:complete");

/**
 * Schedule terminal side effects in a non-blocking after() block.
 */
function scheduleTerminalSideEffects(
  runId: string,
  status: "completed" | "failed",
  orgId: string,
  errorMsg?: string,
): void {
  after(async () => {
    await dispatchTerminalSideEffects(runId, status, errorMsg, () => {
      return drainOrgQueue(orgId, dispatchQueuedZeroRun);
    });
    await processOrgUsageEvents(orgId);
  });
}

/**
 * Build a RunResult from a checkpoint record.
 *
 * `checkpoint.artifactSnapshots` is a JSONB column (runtime type `unknown`)
 * that may contain either the legacy Record<name, version> shape or the
 * canonical Array<{name, version, mountPath}>. `RunResult.artifact` is still
 * Record-shaped for downstream consumers, so we project the array shape back
 * to Record on the way out. Empty payloads project to null and are dropped.
 */
function buildRunResult(
  checkpoint: typeof checkpoints.$inferSelect,
  sessionId: string | undefined,
): RunResult {
  const artifactRecord = decodeToRecord(checkpoint.artifactSnapshots);
  const volumeVersions = checkpoint.volumeVersionsSnapshot as
    | { versions: Record<string, string> }
    | undefined;

  const result: RunResult = {
    checkpointId: checkpoint.id,
    agentSessionId: sessionId ?? checkpoint.conversationId,
    conversationId: checkpoint.conversationId,
    volumes: volumeVersions?.versions,
  };

  if (artifactRecord) {
    result.artifact = artifactRecord;
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
            sandboxId: body.sandboxId,
            sandboxReuseResult: body.sandboxReuseResult,
          },
          ["pending", "running", "timeout"],
        );

        // Dispatch callbacks so the user gets notified about the failure
        // (previously this path returned without dispatching)
        if (transitioned) {
          await publishRunChangedForUserSafely(run.userId, body.runId, {
            status: "failed",
          });
          scheduleTerminalSideEffects(
            body.runId,
            "failed",
            run.orgId,
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

      if (body.lastEventSequence !== undefined) {
        const visibility = await waitForAgentEventPrefixVisible(
          body.runId,
          body.lastEventSequence,
        );

        if (!visibility.visible) {
          log.warn("Completing run before all agent events are Axiom-visible", {
            runId: body.runId,
            targetSequence: visibility.targetSequence,
            visibleThrough: visibility.visibleThrough,
            attempts: visibility.attempts,
            elapsedMs: visibility.elapsedMs,
            reason: visibility.reason,
            error: visibility.error,
          });
        }
      }

      // Atomically transition to "completed". Also accept "timeout" so a
      // sandbox that eventually reports success after a heartbeat-timeout
      // sweep can still upgrade the run state.
      const transitioned = await transitionRunStatus(
        body.runId,
        {
          status: "completed",
          completedAt: new Date(),
          result,
          sandboxId: body.sandboxId,
          sandboxReuseResult: body.sandboxReuseResult,
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

      await publishRunChangedForUserSafely(run.userId, body.runId, {
        status: "completed",
      });
      finalStatus = "completed";
      log.debug(`Run ${body.runId} completed successfully`);
    } else {
      // Failure: store the runner's real error (e.g., codex CLI stderr)
      // verbatim in agent_runs.error. The frontend's formatChatRunErrorMessage
      // (chat-thread/chat-run-error-message.ts) decides what the user sees:
      // matches ACTIONABLE_ERROR_SNIPPETS → render the underlying error;
      // otherwise → polished generic UI ("Oops..." / "Report this issue"
      // with streak logic). Preserving the raw error here keeps the DB
      // column debug-useful and lets future actionable mappings in
      // RUN_ERROR_GUIDANCE light up automatically without a migration.
      errorMessage = body.error?.trim() || "Run failed without error message";

      // Also accept "timeout" so the sandbox's own exit-code-based error
      // supersedes a stale "Run timed out (no heartbeat)" stamped earlier
      // by the cleanup cron.
      const transitioned = await transitionRunStatus(
        body.runId,
        {
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
          sandboxId: body.sandboxId,
          sandboxReuseResult: body.sandboxReuseResult,
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

      await publishRunChangedForUserSafely(run.userId, body.runId, {
        status: "failed",
      });
      finalStatus = "failed";
      // Structured log: each field is queryable in Axiom so we can group
      // failures by exitCode or errorMessage. Without these dimensions,
      // grouping failed runs in the dashboard requires a fresh deploy.
      log.warn(`Run ${body.runId} failed`, {
        runId: body.runId,
        exitCode: body.exitCode,
        errorMessage,
      });
    }

    // Dispatch all registered callbacks and drain run queue (non-blocking)
    scheduleTerminalSideEffects(
      body.runId,
      finalStatus,
      run.orgId,
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
  routeName: "webhooks.agent.complete",
  errorHandler,
});

export { handler as POST };
