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
import { eq, and, inArray } from "drizzle-orm";
import { dispatchTerminalSideEffects } from "../../../../../src/lib/infra/run/run-status";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { buildRunResultFromCheckpoint } from "../../../../../src/lib/infra/run/run-result";
import type {
  RunResult,
  RunStatus,
} from "../../../../../src/lib/infra/run/types";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  drainOrgQueue,
  dispatchQueuedZeroRun,
} from "../../../../../src/lib/zero/zero-run-queue-service";
import { processOrgUsageEvents } from "../../../../../src/lib/zero/credit/usage-event-service";
import { waitForAgentEventPrefixVisible } from "../../../../../src/lib/infra/run/agent-event-visibility";
import { publishRunChangedForUserSafely } from "../../../../../src/lib/infra/run/run-realtime";
import { after } from "next/server";
import { env } from "../../../../../src/env";
import type { Database } from "../../../../../src/types/global";

const log = logger("webhook:complete");

const COMPLETABLE_RUN_STATUSES: RunStatus[] = ["pending", "running", "timeout"];

/**
 * Schedule terminal side effects in a non-blocking after() block.
 */
function scheduleTerminalSideEffects(
  runId: string,
  status: "completed" | "failed",
  orgId: string,
  errorMsg?: string,
  result?: RunResult,
): void {
  after(async () => {
    await dispatchTerminalSideEffects(runId, status, {
      error: errorMsg,
      result,
      drain: () => {
        return drainOrgQueue(orgId, dispatchQueuedZeroRun);
      },
    });
    await processOrgUsageEvents(orgId);
  });
}

async function buildRunResultForRun(
  runId: string,
  db: Pick<Database, "select"> = globalThis.services.db,
): Promise<RunResult | undefined> {
  const [checkpoint] = await db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.runId, runId))
    .limit(1);

  if (!checkpoint) {
    return undefined;
  }

  // Get agent session for the conversation
  const [session] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, checkpoint.conversationId))
    .limit(1);

  return buildRunResultFromCheckpoint(checkpoint, session?.id);
}

type CompleteTransitionResult =
  | { kind: "not-found" }
  | { kind: "already-terminal"; status: "completed" | "failed" }
  | { kind: "missing-checkpoint"; transitioned: boolean }
  | { kind: "completed"; result: RunResult }
  | { kind: "failed"; errorMessage: string; result?: RunResult }
  | { kind: "skipped"; status: "completed" | "failed" };

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

    if (body.exitCode === 0) {
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
    }

    const transitionResult =
      await globalThis.services.db.transaction<CompleteTransitionResult>(
        async (tx) => {
          // Serialize the terminal decision with checkpoint writes. A checkpoint
          // webhook can hold this row lock while inserting the checkpoint row;
          // reading checkpoint before waiting for that lock can falsely decide
          // that a recoverable checkpoint is missing.
          const [lockedRun] = await tx
            .select()
            .from(agentRuns)
            .where(
              and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)),
            )
            .for("update")
            .limit(1);

          if (!lockedRun) {
            return { kind: "not-found" };
          }

          if (
            lockedRun.status === "completed" ||
            lockedRun.status === "failed"
          ) {
            return {
              kind: "already-terminal",
              status: lockedRun.status as "completed" | "failed",
            };
          }

          if (body.exitCode === 0) {
            // Success: query checkpoint under the same run lock used for the
            // terminal transition, then store the result in agent_runs.
            const result = await buildRunResultForRun(body.runId, tx);

            if (!result) {
              const [updated] = await tx
                .update(agentRuns)
                .set({
                  status: "failed",
                  completedAt: new Date(),
                  error: "Checkpoint for run not found",
                  sandboxId: body.sandboxId,
                  sandboxReuseResult: body.sandboxReuseResult,
                })
                .where(
                  and(
                    eq(agentRuns.id, body.runId),
                    inArray(agentRuns.status, COMPLETABLE_RUN_STATUSES),
                  ),
                )
                .returning({ id: agentRuns.id });

              return {
                kind: "missing-checkpoint",
                transitioned: Boolean(updated),
              };
            }

            const [updated] = await tx
              .update(agentRuns)
              .set({
                status: "completed",
                completedAt: new Date(),
                result,
                sandboxId: body.sandboxId,
                sandboxReuseResult: body.sandboxReuseResult,
              })
              .where(
                and(
                  eq(agentRuns.id, body.runId),
                  inArray(agentRuns.status, COMPLETABLE_RUN_STATUSES),
                ),
              )
              .returning({ id: agentRuns.id });

            if (!updated) {
              return { kind: "skipped", status: "completed" };
            }

            return { kind: "completed", result };
          }

          const reportUrl = `${env().NEXT_PUBLIC_APP_URL}/runs/${body.runId}/report-error`;
          const errorMessage = `An unexpected error occurred. [Report this issue](${reportUrl})`;
          const result = await buildRunResultForRun(body.runId, tx);
          const update = {
            status: "failed" as const,
            completedAt: new Date(),
            error: errorMessage,
            sandboxId: body.sandboxId,
            sandboxReuseResult: body.sandboxReuseResult,
            ...(result ? { result } : {}),
          };

          const [updated] = await tx
            .update(agentRuns)
            .set(update)
            .where(
              and(
                eq(agentRuns.id, body.runId),
                inArray(agentRuns.status, COMPLETABLE_RUN_STATUSES),
              ),
            )
            .returning({ id: agentRuns.id });

          if (!updated) {
            return { kind: "skipped", status: "failed" };
          }

          return { kind: "failed", errorMessage, result };
        },
      );

    if (transitionResult.kind === "not-found") {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    if (transitionResult.kind === "already-terminal") {
      log.debug(
        `Run ${body.runId} already ${transitionResult.status}, skipping duplicate completion`,
      );
      return {
        status: 200 as const,
        body: {
          success: true,
          status: transitionResult.status,
        },
      };
    }

    if (transitionResult.kind === "missing-checkpoint") {
      // Dispatch callbacks so the user gets notified about the failure
      // (previously this path returned without dispatching).
      if (transitionResult.transitioned) {
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

    if (transitionResult.kind === "skipped") {
      if (transitionResult.status === "completed") {
        log.debug(
          `Run ${body.runId} already transitioned, skipping duplicate completion`,
        );
      } else {
        log.debug(
          `Run ${body.runId} already transitioned, skipping duplicate failure`,
        );
      }
      return {
        status: 200 as const,
        body: { success: true, status: transitionResult.status },
      };
    }

    const finalStatus =
      transitionResult.kind === "completed" ? "completed" : "failed";
    const errorMessage =
      transitionResult.kind === "failed"
        ? transitionResult.errorMessage
        : undefined;
    const finalResult = transitionResult.result;

    if (finalStatus === "completed") {
      await publishRunChangedForUserSafely(run.userId, body.runId, {
        status: "completed",
      });
      log.debug(`Run ${body.runId} completed successfully`);
    } else {
      await publishRunChangedForUserSafely(run.userId, body.runId, {
        status: "failed",
      });
      log.warn(`Run ${body.runId} failed: ${errorMessage}`);
    }

    // Dispatch all registered callbacks and drain run queue (non-blocking)
    scheduleTerminalSideEffects(
      body.runId,
      finalStatus,
      run.orgId,
      errorMessage,
      finalResult,
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
