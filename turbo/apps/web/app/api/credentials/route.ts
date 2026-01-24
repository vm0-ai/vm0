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
import {
  listCredentials,
  setCredential,
} from "../../../src/lib/credential/credential-service";
import { logger } from "../../../src/lib/logger";
import { BadRequestError } from "../../../src/lib/errors";

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

    const credentials = await listCredentials(userId);

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
      const credential = await setCredential(userId, name, value, description);

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
      if (error instanceof BadRequestError) {
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

const handler = createHandler(credentialsMainContract, router, {
  errorHandler,
});

export { handler as GET, handler as PUT };
