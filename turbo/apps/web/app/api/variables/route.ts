import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import {
  variablesMainContract,
  createErrorResponse,
  ApiError,
} from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getAuthContext } from "../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../src/lib/scope/resolve-scope";
import {
  listVariables,
  setVariable,
} from "../../../src/lib/variable/variable-service";
import { logger } from "../../../src/lib/logger";
import { isBadRequest } from "../../../src/lib/errors";

const log = logger("api:variables");

const router = tsr.router(variablesMainContract, {
  /**
   * GET /api/variables - List all variables (includes values)
   */
  list: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, scopeId: tokenScopeId } = authCtx;

    const scopeSlug = new URL(request.url).searchParams.get("scope");
    const orgParam = new URL(request.url).searchParams.get("org");
    const { scope } = await resolveScope(
      userId,
      scopeSlug,
      orgParam,
      tokenScopeId,
    );
    const vars = await listVariables(scope.orgId, userId);

    return {
      status: 200 as const,
      body: {
        variables: vars.map((v) => ({
          id: v.id,
          name: v.name,
          value: v.value,
          description: v.description,
          createdAt: v.createdAt.toISOString(),
          updatedAt: v.updatedAt.toISOString(),
        })),
      },
    };
  },

  /**
   * PUT /api/variables - Create or update a variable
   */
  set: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, scopeId: tokenScopeId } = authCtx;

    const { name, value, description } = body;

    log.debug("setting variable", { userId, name });

    try {
      const scopeSlug = new URL(request.url).searchParams.get("scope");
      const orgParam = new URL(request.url).searchParams.get("org");
      const { scope } = await resolveScope(
        userId,
        scopeSlug,
        orgParam,
        tokenScopeId,
      );
      const variable = await setVariable(
        scope.orgId,
        scope.id,
        userId,
        name,
        value,
        description,
      );

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
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      throw error;
    }
  },
});

/**
 * Custom error handler for variables API
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

const handler = createHandler(variablesMainContract, router, {
  errorHandler,
});

export { handler as GET, handler as PUT };
