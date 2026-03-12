import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import { scopeContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getAuthContext } from "../../../src/lib/auth/get-user-id";
import { updateScopeSlug } from "../../../src/lib/scope/scope-service";
import { resolveScope } from "../../../src/lib/scope/resolve-scope";
import type { ResolvedScope } from "../../../src/lib/scope/resolve-scope";
import { logger } from "../../../src/lib/logger";
import { isBadRequest, isForbidden, isNotFound } from "../../../src/lib/errors";

const log = logger("api:scope");

function resolvedScopeToResponse(scope: ResolvedScope) {
  return {
    id: scope.orgId,
    slug: scope.slug,
    tier: scope.tier,
  };
}

const router = tsr.router(scopeContract, {
  /**
   * GET /api/scope - Get current user's default scope
   *
   * Resolves the active scope via orgId from Clerk session,
   * or falls back to the user's default scope (first admin membership).
   */
  get: async ({ headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    try {
      const { scope: resolvedScope } = await resolveScope(
        userId,
        null,
        null,
        tokenOrgId,
      );

      return {
        status: 200 as const,
        body: resolvedScopeToResponse(resolvedScope),
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },

  /**
   * PUT /api/scope - Update active scope slug
   *
   * Resolves the active scope via orgId from Clerk session,
   * or falls back to the user's default scope (first admin membership).
   */
  update: async ({ body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    const { slug, force } = body;

    log.debug("updating scope", { userId, slug, force });

    let resolvedScope;
    try {
      ({ scope: resolvedScope } = await resolveScope(
        userId,
        null,
        null,
        tokenOrgId,
      ));
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse(
          "NOT_FOUND",
          "No scope configured. Set your scope with: vm0 scope set <slug>",
        );
      }
      throw error;
    }

    try {
      const scope = await updateScopeSlug(
        resolvedScope.orgId,
        slug,
        userId,
        force,
      );

      return { status: 200 as const, body: resolvedScopeToResponse(scope) };
    } catch (error) {
      if (isBadRequest(error)) {
        // Check if it's a conflict error (slug already exists)
        if (error.message.includes("already exists")) {
          return {
            status: 409 as const,
            body: {
              error: { message: "Resource conflict", code: "CONFLICT" },
            },
          };
        }
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      if (isForbidden(error)) {
        return createErrorResponse("FORBIDDEN", "Access denied");
      }
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },
});

/**
 * Custom error handler for scope API
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

const handler = createHandler(scopeContract, router, {
  errorHandler,
});

export { handler as GET, handler as PUT };
