import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { webhookCompleteContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { checkpoints } from "../../../../../src/db/schema/checkpoint";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  sendVm0ResultEvent,
  sendVm0ErrorEvent,
} from "../../../../../src/lib/events";
import { e2bService } from "../../../../../src/lib/e2b/e2b-service";
import type { ArtifactSnapshot } from "../../../../../src/lib/checkpoint";

const router = tsr.router(webhookCompleteContract, {
  complete: async ({ body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    console.log(
      `[Complete API] Received completion for run ${body.runId}, exitCode=${body.exitCode}`,
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

    // Idempotency check: if run is already completed/failed, return early
    if (run.status === "completed" || run.status === "failed") {
      console.log(
        `[Complete API] Run ${body.runId} already ${run.status}, skipping duplicate completion`,
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

    try {
      if (body.exitCode === 0) {
        // Success: query checkpoint and send vm0_result
        const [checkpoint] = await globalThis.services.db
          .select()
          .from(checkpoints)
          .where(eq(checkpoints.runId, body.runId))
          .limit(1);

        if (!checkpoint) {
          // Send error event and update run status
          await sendVm0ErrorEvent({
            runId: body.runId,
            error: "Checkpoint for run not found",
            sandboxId,
          });

          await globalThis.services.db
            .update(agentRuns)
            .set({ status: "failed", completedAt: new Date() })
            .where(eq(agentRuns.id, body.runId));

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

        // Extract artifact info from checkpoint
        const artifactSnapshot =
          checkpoint.artifactSnapshot as ArtifactSnapshot;
        const volumeVersions = checkpoint.volumeVersionsSnapshot as
          | { versions: Record<string, string> }
          | undefined;

        // Send vm0_result event
        await sendVm0ResultEvent({
          runId: body.runId,
          checkpointId: checkpoint.id,
          agentSessionId: session?.id ?? checkpoint.conversationId,
          conversationId: checkpoint.conversationId,
          artifact: {
            [artifactSnapshot.artifactName]: artifactSnapshot.artifactVersion,
          },
          volumes: volumeVersions?.versions,
        });

        // Update run status to completed
        await globalThis.services.db
          .update(agentRuns)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(agentRuns.id, body.runId));

        finalStatus = "completed";
        console.log(`[Complete API] Run ${body.runId} completed successfully`);
      } else {
        // Failure: send vm0_error event
        const errorMessage =
          body.error || `Agent exited with code ${body.exitCode}`;

        await sendVm0ErrorEvent({
          runId: body.runId,
          error: errorMessage,
          sandboxId,
        });

        // Update run status to failed
        await globalThis.services.db
          .update(agentRuns)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(agentRuns.id, body.runId));

        finalStatus = "failed";
        console.log(`[Complete API] Run ${body.runId} failed: ${errorMessage}`);
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
    } catch (error) {
      console.error("[Complete API] Error:", error);

      // Try to send vm0_error event
      try {
        await sendVm0ErrorEvent({
          runId: body.runId,
          error: error instanceof Error ? error.message : "Complete API failed",
          sandboxId,
        });
      } catch {
        console.error(
          "[Complete API] Failed to send vm0_error event after error",
        );
      }

      // Still try to kill sandbox on error
      if (sandboxId) {
        await e2bService.killSandbox(sandboxId);
      }

      return {
        status: 500 as const,
        body: {
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            code: "INTERNAL_ERROR",
          },
        },
      };
    }
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

const handler = createNextHandler(webhookCompleteContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as POST };
