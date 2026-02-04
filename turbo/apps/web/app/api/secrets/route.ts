import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import { secretsMainContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { listSecrets, setSecret } from "../../../src/lib/secret/secret-service";
import { logger } from "../../../src/lib/logger";
import { isBadRequest } from "../../../src/lib/errors";

const log = logger("api:secrets");

const router = tsr.router(secretsMainContract, {
  /**
   * GET /api/secrets - List all secrets
   */
  list: async ({ headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const secrets = await listSecrets(userId);

    return {
      status: 200 as const,
      body: {
        secrets: secrets.map((c) => ({
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
   * PUT /api/secrets - Create or update a secret
   */
  set: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { name, value, description } = body;

    log.debug("setting secret", { userId, name });

    try {
      const secret = await setSecret(userId, name, value, description);

      return {
        status: 200 as const,
        body: {
          id: secret.id,
          name: secret.name,
          description: secret.description,
          type: secret.type,
          createdAt: secret.createdAt.toISOString(),
          updatedAt: secret.updatedAt.toISOString(),
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
 * Custom error handler for secrets API
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

const handler = createHandler(secretsMainContract, router, {
  errorHandler,
});

export { handler as GET, handler as PUT };
