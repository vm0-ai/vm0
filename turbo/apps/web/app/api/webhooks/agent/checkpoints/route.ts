import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { webhookCheckpointsContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { checkpointService } from "../../../../../src/lib/checkpoint";

const router = tsr.router(webhookCheckpointsContract, {
  create: async ({ body }) => {
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
      `[Checkpoint API] Received checkpoint request for run ${body.runId} from user ${userId}`,
    );

    // Verify run exists and belongs to the authenticated user
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

    // Note: We don't check run status here because the checkpoint is called from within
    // the sandbox before the E2B service updates the run status to "completed"

    try {
      // Create checkpoint
      const result = await checkpointService.createCheckpoint(body);

      console.log(
        `[Checkpoint API] Checkpoint created: ${result.checkpointId}, session: ${result.agentSessionId}, conversation: ${result.conversationId}`,
      );

      // Note: vm0_result event is now sent by the complete API
      // This endpoint only handles checkpoint data persistence

      return {
        status: 200 as const,
        body: {
          checkpointId: result.checkpointId,
          agentSessionId: result.agentSessionId,
          conversationId: result.conversationId,
          artifact: result.artifact,
          volumes: result.volumes,
        },
      };
    } catch (error) {
      console.error("[Checkpoint API] Error:", error);

      // Note: vm0_error event is now sent by the complete API
      // If checkpoint fails, run-agent.sh will call complete API with exitCode != 0

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

const handler = createNextHandler(webhookCheckpointsContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as POST };
