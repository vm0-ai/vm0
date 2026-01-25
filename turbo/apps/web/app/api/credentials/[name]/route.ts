import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import {
  credentialsByNameContract,
  createErrorResponse,
  ApiError,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  getCredential,
  deleteCredential,
} from "../../../../src/lib/credential/credential-service";
import { logger } from "../../../../src/lib/logger";
import { NotFoundError } from "../../../../src/lib/errors";

const log = logger("api:credentials");

const router = tsr.router(credentialsByNameContract, {
  /**
   * GET /api/credentials/:name - Get a credential by name
   */
  get: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const credential = await getCredential(userId, params.name);
    if (!credential) {
      return createErrorResponse(
        "NOT_FOUND",
        `Credential "${params.name}" not found`,
      );
    }

    return {
      status: 200 as const,
      body: {
        id: credential.id,
        name: credential.name,
        description: credential.description,
        type: credential.type,
        createdAt: credential.createdAt.toISOString(),
        updatedAt: credential.updatedAt.toISOString(),
      },
    };
  },

  /**
   * DELETE /api/credentials/:name - Delete a credential
   */
  delete: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    log.debug("deleting credential", { userId, name: params.name });

    try {
      await deleteCredential(userId, params.name);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        return createErrorResponse("NOT_FOUND", error.message);
      }
      throw error;
    }
  },
});

/**
 * Custom error handler for credentials by name API
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

const handler = createHandler(credentialsByNameContract, router, {
  errorHandler,
});

export { handler as GET, handler as DELETE };
