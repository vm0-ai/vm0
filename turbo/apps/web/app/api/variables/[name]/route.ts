import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import {
  variablesByNameContract,
  createErrorResponse,
  ApiError,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  getVariable,
  deleteVariable,
} from "../../../../src/lib/variable/variable-service";
import { logger } from "../../../../src/lib/logger";
import { isNotFound } from "../../../../src/lib/errors";

const log = logger("api:variables");

const router = tsr.router(variablesByNameContract, {
  /**
   * GET /api/variables/:name - Get a variable by name (includes value)
   */
  get: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const variable = await getVariable(userId, params.name);
    if (!variable) {
      return createErrorResponse(
        "NOT_FOUND",
        `Variable "${params.name}" not found`,
      );
    }

    return {
      status: 200 as const,
      body: {
        id: variable.id,
        name: variable.name,
        value: variable.value,
        description: variable.description,
        createdAt: variable.createdAt.toISOString(),
        updatedAt: variable.updatedAt.toISOString(),
      },
    };
  },

  /**
   * DELETE /api/variables/:name - Delete a variable
   */
  delete: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    log.debug("deleting variable", { userId, name: params.name });

    try {
      await deleteVariable(userId, params.name);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", error.message);
      }
      throw error;
    }
  },
});

/**
 * Custom error handler for variables by name API
 */
function errorHandler(err: unknown): TsRestResponse | void {
  // Handle ts-rest RequestValidationError
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    // Handle path params validation errors
    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        const message = issue.message;

        return TsRestResponse.fromJson(
          { error: { message, code: ApiError.BAD_REQUEST.code } },
          { status: ApiError.BAD_REQUEST.status },
        );
      }
    }
  }

  // Let other errors propagate
  return undefined;
}

const handler = createHandler(variablesByNameContract, router, {
  errorHandler,
});

export { handler as GET, handler as DELETE };
