import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import { secretsMainContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getAuthContext } from "../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../src/lib/scope/resolve-scope";
import { listSecrets, setSecret } from "../../../src/lib/secret/secret-service";
import { logger } from "../../../src/lib/logger";
import { isBadRequest } from "../../../src/lib/errors";

const log = logger("api:secrets");

const router = tsr.router(secretsMainContract, {
  /**
   * GET /api/secrets - List all secrets
   */
  list: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, scopeId: tokenScopeId } = authCtx;

    const scopeSlug = new URL(request.url).searchParams.get("scope");
    const { scope } = await resolveScope(userId, scopeSlug, null, tokenScopeId);
    const secrets = await listSecrets(scope.id, userId);

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
  set: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, scopeId: tokenScopeId } = authCtx;

    const { name, value, description } = body;

    log.debug("setting secret", { userId, name });

    try {
      const scopeSlug = new URL(request.url).searchParams.get("scope");
      const { scope } = await resolveScope(
        userId,
        scopeSlug,
        null,
        tokenScopeId,
      );
      const secret = await setSecret(
        scope.id,
        userId,
        name,
        value,
        scope.clerkOrgId,
        description,
      );

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
