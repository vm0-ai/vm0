import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookCheckpointsContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { checkpointService } from "../../../../../src/lib/checkpoint";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhook:checkpoints");

const router = tsr.router(webhookCheckpointsContract, {
  create: async ({ body }) => {
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
      `Received checkpoint request for run ${body.runId} from user ${userId}`,
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

    // Create checkpoint
    const result = await checkpointService.createCheckpoint(body);

    log.debug(
      `Checkpoint created: ${result.checkpointId}, session: ${result.agentSessionId}, conversation: ${result.conversationId}`,
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

const handler = createHandler(webhookCheckpointsContract, router, {
  errorHandler,
});

export { handler as POST };
