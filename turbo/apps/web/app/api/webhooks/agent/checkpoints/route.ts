import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookCheckpointsContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { createCheckpoint } from "../../../../../src/lib/infra/checkpoint";
import { isForeignKeyViolation } from "../../../../../src/lib/shared/pg-errors";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("webhook:checkpoints");

const router = tsr.router(webhookCheckpointsContract, {
  create: async ({ body, headers }) => {
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
      `Received checkpoint request for run ${body.runId} from user ${userId}`,
    );

    // `createCheckpoint` fetches `agent_runs` internally and throws
    // `notFound` if the row is missing — no up-front SELECT here. If
    // the run vanishes concurrent with a downstream INSERT
    // (conversations / checkpoints, both FK-constrained on
    // `agent_runs.id` — see #10725 and the aggregate-deletion paths
    // tracked in #10763), PG raises SQLSTATE 23503; we surface it as
    // 404 instead of 500 to keep the same "run not found" contract
    // the caller already handles.
    try {
      const result = await createCheckpoint(body, userId);

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
          artifacts: result.artifacts,
          volumes: result.volumes,
        },
      };
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        log.info("Run deleted concurrent with checkpoint, dropping", {
          runId: body.runId,
        });
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent run not found", code: "NOT_FOUND" },
          },
        };
      }
      throw err;
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

const handler = createHandler(webhookCheckpointsContract, router, {
  routeName: "webhooks.agent.checkpoints",
  errorHandler,
});

export { handler as POST };
