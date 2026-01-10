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
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { e2bService } from "../../../../../src/lib/e2b/e2b-service";
import type { ArtifactSnapshot } from "../../../../../src/lib/checkpoint";
import type { RunResult } from "../../../../../src/lib/run/types";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhook:complete");

const router = tsr.router(webhookCompleteContract, {
  complete: async ({ body }) => {
    initServices();

    // Authenticate with sandbox JWT and verify runId matches
    const auth = await getSandboxAuthForRun(body.runId);
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

    const sandboxId = run.sandboxId ?? undefined;

    // Early check: if run is already completed/failed, return the existing status
    // Note: We still do atomic updates below to handle race conditions
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

    if (body.exitCode === 0) {
      // Success: query checkpoint and store result in run table
      const [checkpoint] = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, body.runId))
        .limit(1);

      if (!checkpoint) {
        // Atomic update: only update if status is still "running"
        const updateResult = await globalThis.services.db
          .update(agentRuns)
          .set({
            status: "failed",
            completedAt: new Date(),
            error: "Checkpoint for run not found",
          })
          .where(
            and(eq(agentRuns.id, body.runId), eq(agentRuns.status, "running")),
          )
          .returning({ id: agentRuns.id });

        if (updateResult.length === 0) {
          // Run was already completed/failed by another request
          log.debug(`Run ${body.runId} already completed by another request`);
          const [currentRun] = await globalThis.services.db
            .select({ status: agentRuns.status })
            .from(agentRuns)
            .where(eq(agentRuns.id, body.runId))
            .limit(1);
          return {
            status: 200 as const,
            body: {
              success: true,
              status:
                (currentRun?.status as "completed" | "failed") ?? "failed",
            },
          };
        }

        if (sandboxId) {
          await e2bService.killSandbox(sandboxId);
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

      // Extract artifact info from checkpoint (may be null for runs without artifact)
      const artifactSnapshot =
        checkpoint.artifactSnapshot as ArtifactSnapshot | null;
      const volumeVersions = checkpoint.volumeVersionsSnapshot as
        | { versions: Record<string, string> }
        | undefined;

      // Build result object to store in run table
      const result: RunResult = {
        checkpointId: checkpoint.id,
        agentSessionId: session?.id ?? checkpoint.conversationId,
        conversationId: checkpoint.conversationId,
        volumes: volumeVersions?.versions,
      };

      // Only add artifact if present in checkpoint
      if (artifactSnapshot) {
        result.artifact = {
          [artifactSnapshot.artifactName]: artifactSnapshot.artifactVersion,
        };
      }

      // Atomic update: only update if status is still "running"
      // This prevents race conditions where multiple completion requests arrive
      const updateResult = await globalThis.services.db
        .update(agentRuns)
        .set({
          status: "completed",
          completedAt: new Date(),
          result,
        })
        .where(
          and(eq(agentRuns.id, body.runId), eq(agentRuns.status, "running")),
        )
        .returning({ id: agentRuns.id });

      if (updateResult.length === 0) {
        // Run was already completed/failed by another request
        log.debug(`Run ${body.runId} already completed by another request`);
        const [currentRun] = await globalThis.services.db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, body.runId))
          .limit(1);
        return {
          status: 200 as const,
          body: {
            success: true,
            status:
              (currentRun?.status as "completed" | "failed") ?? "completed",
          },
        };
      }

      finalStatus = "completed";
      log.debug(`Run ${body.runId} completed successfully`);
    } else {
      // Failure: store error in run table
      const errorMessage =
        body.error || `Agent exited with code ${body.exitCode}`;

      // Atomic update: only update if status is still "running"
      // This prevents overwriting a successful completion with a failure
      const updateResult = await globalThis.services.db
        .update(agentRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
        })
        .where(
          and(eq(agentRuns.id, body.runId), eq(agentRuns.status, "running")),
        )
        .returning({ id: agentRuns.id });

      if (updateResult.length === 0) {
        // Run was already completed/failed by another request
        log.debug(
          `Run ${body.runId} already completed by another request, ignoring failure: ${errorMessage}`,
        );
        const [currentRun] = await globalThis.services.db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, body.runId))
          .limit(1);
        return {
          status: 200 as const,
          body: {
            success: true,
            status: (currentRun?.status as "completed" | "failed") ?? "failed",
          },
        };
      }

      finalStatus = "failed";
      log.warn(`Run ${body.runId} failed: ${errorMessage}`);
    }

    // Kill sandbox (wait for completion to ensure cleanup before response)
    if (sandboxId) {
      await e2bService.killSandbox(sandboxId);
    }

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
