import { isApiError } from "@vm0/api-services/errors";
import { isRunDispatchError } from "../infra/run";

/**
 * Translate createZeroRun() errors into API response format.
 *
 * Mirrors the handleCreateRunError pattern from /api/agent/runs.
 */
export function handleCreateRunError(error: unknown) {
  // Dispatch errors with a runId take priority -- return partial result.
  // sessionId is populated by markRunFailed() post-INSERT (see #10323).
  if (isRunDispatchError(error) && error.runId && error.sessionId) {
    return {
      status: 201 as const,
      body: {
        runId: error.runId,
        status: "failed" as const,
        sessionId: error.sessionId,
        error: error.message,
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
