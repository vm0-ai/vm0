import { NextRequest } from "next/server";
import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import {
  credentialsMainContract,
  createErrorResponse,
  ApiError,
} from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { listSecrets, setSecret } from "../../../src/lib/secret/secret-service";
import { logger } from "../../../src/lib/logger";
import { isBadRequest } from "../../../src/lib/errors";

const log = logger("api:credentials");

const router = tsr.router(credentialsMainContract, {
  /**
   * GET /api/credentials - List all credentials
   */
  list: async ({ headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const credentials = await listSecrets(userId);

    return {
      status: 200 as const,
      body: {
        credentials: credentials.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          type: c.type,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        })),
      },
    };
  },

  /**
   * PUT /api/credentials - Create or update a credential
   */
  set: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { name, value, description } = body;

    log.debug("setting credential", { userId, name });

    try {
      const credential = await setSecret(userId, name, value, description);

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
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      throw error;
    }
  },
});

/**
 * Custom error handler for credentials API
 */
function errorHandler(err: unknown): TsRestResponse | void {
  // Handle ts-rest RequestValidationError
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    // Handle body validation errors
    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
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

const baseHandler = createHandler(credentialsMainContract, router, {
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

export { deprecatedHandler as GET, deprecatedHandler as PUT };
