import { eq, and } from "drizzle-orm";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroRunsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { createZeroRun } from "../../../../src/lib/zero/zero-run-service";
import { isApiError } from "../../../../src/lib/errors";
import { isRunDispatchError } from "../../../../src/lib/run";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";

/**
 * Translate createZeroRun() errors into API response format.
 *
 * Mirrors the handleCreateRunError pattern from /api/agent/runs.
 */
function handleCreateRunError(error: unknown) {
  // Dispatch errors with a runId take priority — return partial result
  if (isRunDispatchError(error) && error.runId) {
    return {
      status: 201 as const,
      body: {
        runId: error.runId,
        status: "failed" as const,
        error: error.message,
        createdAt: error.createdAt?.toISOString() ?? "",
      },
    };
  }

  if (isApiError(error)) {
    const status = error.code === "UNAUTHORIZED" ? 404 : error.statusCode;
    const code = error.code === "UNAUTHORIZED" ? "NOT_FOUND" : error.code;
    const message =
      error.code === "UNAUTHORIZED" ? "Resource not found" : error.message;
    return {
      status: status as 400 | 401 | 403 | 404,
      body: { error: { message, code } },
    };
  }

  return null;
}

const router = tsr.router(zeroRunsMainContract, {
  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const composeId = body.agentId;
      if (!composeId) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "agentId is required",
              code: "BAD_REQUEST" as const,
            },
          },
        };
      }

      const [agent] = await globalThis.services.db
        .select({ id: zeroAgents.id })
        .from(agentComposes)
        .innerJoin(
          zeroAgents,
          and(
            eq(zeroAgents.orgId, agentComposes.orgId),
            eq(zeroAgents.name, agentComposes.name),
          ),
        )
        .where(eq(agentComposes.id, composeId))
        .limit(1);

      if (!agent) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent not found", code: "NOT_FOUND" as const },
          },
        };
      }

      const result = await createZeroRun({
        userId: authCtx.userId,
        prompt: body.prompt,
        agentId: agent.id,
        sessionId: body.sessionId,
        appendSystemPrompt: body.appendSystemPrompt,
        modelProvider: body.modelProvider,
        triggerSource: "web",
      });

      return {
        status: 201 as const,
        body: {
          runId: result.runId,
          status: result.status,
          sandboxId: result.sandboxId,
          createdAt: result.createdAt.toISOString(),
        },
      };
    } catch (error) {
      const errorResponse = handleCreateRunError(error);
      if (errorResponse) {
        return errorResponse;
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroRunsMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs"),
});

export { handler as POST };
