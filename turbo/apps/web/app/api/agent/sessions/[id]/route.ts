import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { sessionsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveCallerOrgId } from "../../../../../src/lib/org/resolve-org";
import { getSessionResponse } from "../../../../../src/lib/agent-session/agent-session-service";
import { isNotFound, isForbidden } from "../../../../../src/lib/errors";

const router = tsr.router(sessionsByIdContract, {
  getById: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const callerOrgId = await resolveCallerOrgId(authCtx, request);
    if (!callerOrgId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Session not found", code: "NOT_FOUND" },
        },
      };
    }

    try {
      const session = await getSessionResponse(params.id, userId, callerOrgId);
      return { status: 200 as const, body: session };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: { error: { message: error.message, code: "NOT_FOUND" } },
        };
      }
      if (isForbidden(error)) {
        return {
          status: 403 as const,
          body: { error: { message: error.message, code: "FORBIDDEN" } },
        };
      }
      throw error;
    }
  },
});

interface PathParamsValidationError {
  pathParamsError: {
    issues: Array<{ path: string[]; message: string }>;
  } | null;
}

function isPathParamsError(err: unknown): err is PathParamsValidationError {
  return (
    err !== null &&
    typeof err === "object" &&
    "pathParamsError" in err &&
    (err.pathParamsError === null ||
      (typeof err.pathParamsError === "object" &&
        err.pathParamsError !== null &&
        "issues" in err.pathParamsError &&
        Array.isArray(err.pathParamsError.issues)))
  );
}

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (isPathParamsError(err) && err.pathParamsError) {
    const issue = err.pathParamsError.issues[0];
    if (issue) {
      return TsRestResponse.fromJson(
        { error: { message: issue.message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
  }

  return undefined;
}

const handler = createHandler(sessionsByIdContract, router, {
  errorHandler,
});

export { handler as GET };
