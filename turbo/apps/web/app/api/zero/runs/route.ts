import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroRunsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  startZeroRun,
  isRunDispatchError,
  type RunDispatchError,
} from "../../../../src/lib/run";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { isApiError } from "../../../../src/lib/errors";

/**
 * Translate startZeroRun() errors into API response format.
 * Mirrors handleCreateRunError in /api/agent/runs/route.ts.
 */
function handleStartZeroRunError(error: unknown) {
  if (isApiError(error)) {
    const dispatchError = error as RunDispatchError;
    const runId = dispatchError.runId;
    if (runId) {
      return {
        status: 201 as const,
        body: {
          runId,
          status: "failed" as const,
          error: error.message,
          createdAt: dispatchError.createdAt?.toISOString() ?? "",
        },
      };
    }

    const status = error.code === "UNAUTHORIZED" ? 404 : error.statusCode;
    const code = error.code === "UNAUTHORIZED" ? "NOT_FOUND" : error.code;
    const message =
      error.code === "UNAUTHORIZED" ? "Resource not found" : error.message;
    return {
      status: status as 400 | 401 | 403 | 404,
      body: { error: { message, code } },
    };
  }

  if (isRunDispatchError(error)) {
    return {
      status: 201 as const,
      body: {
        runId: error.runId!,
        status: "failed" as const,
        error: "Run failed",
        createdAt: error.createdAt?.toISOString() ?? "",
      },
    };
  }

  return null;
}

const router = tsr.router(zeroRunsMainContract, {
  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    if (!body.agentComposeId) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "agentComposeId is required",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    try {
      const result = await startZeroRun({
        userId,
        prompt: body.prompt,
        composeId: body.agentComposeId,
        sessionId: body.sessionId,
        appendSystemPrompt: body.appendSystemPrompt,
        disallowedTools: body.disallowedTools,
        tools: body.tools,
        settings: body.settings,
        conversationId: body.conversationId,
        vars: body.vars,
        secrets: body.secrets,
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        memoryName: body.memoryName,
        volumeVersions: body.volumeVersions,
        modelProvider: body.modelProvider,
        triggerSource: "web",
        debugNoMockClaude: body.debugNoMockClaude,
        checkEnv: body.checkEnv,
      });

      return {
        status: 201 as const,
        body: {
          runId: result.runId,
          status: result.status as
            | "queued"
            | "pending"
            | "running"
            | "completed"
            | "failed"
            | "timeout",
          sandboxId: result.sandboxId,
          createdAt: result.createdAt.toISOString(),
        },
      };
    } catch (error) {
      const errorResponse = handleStartZeroRunError(error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  },
});

const handler = createHandler(zeroRunsMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs"),
});

export { handler as POST };
