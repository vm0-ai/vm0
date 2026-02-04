import { NextRequest } from "next/server";
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
  getSecret,
  deleteSecret,
} from "../../../../src/lib/secret/secret-service";
import { logger } from "../../../../src/lib/logger";
import { isNotFound } from "../../../../src/lib/errors";

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

    const credential = await getSecret(userId, params.name);
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
      await deleteSecret(userId, params.name);

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

const baseHandler = createHandler(credentialsByNameContract, router, {
  errorHandler,
});

/**
 * Deprecation warning for /api/credentials endpoints
 */
const DEPRECATION_WARNING =
  "This endpoint is deprecated. Please upgrade your CLI and use /api/secrets instead.";

function addDeprecationHeader(response: Response): Response {
  response.headers.set("X-Deprecation-Warning", DEPRECATION_WARNING);
  return response;
}

async function deprecatedHandler(request: NextRequest): Promise<Response> {
  const response = await baseHandler(request);
  return addDeprecationHeader(response);
}

export { deprecatedHandler as GET, deprecatedHandler as DELETE };
