import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import { scopeContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getAuthContext } from "../../../src/lib/auth/get-user-id";
import {
  createScope,
  updateScopeSlug,
  ensureDefaultScope,
  resolveUnmatchedClerkOrg,
  getScopeByOrgId,
} from "../../../src/lib/scope/scope-service";
import { resolveScope } from "../../../src/lib/scope/resolve-scope";
import { logger } from "../../../src/lib/logger";
import { isBadRequest, isForbidden, isNotFound } from "../../../src/lib/errors";

const log = logger("api:scope");

function scopeToResponseBody(scope: {
  id: string;
  slug: string;
  tier: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: scope.id,
    slug: scope.slug,
    tier: scope.tier,
    createdAt: scope.createdAt.toISOString(),
    updatedAt: scope.updatedAt.toISOString(),
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

      // TODO: 5b-5 — remove scopes table query, change API response
      const scopeRecord = await getScopeByOrgId(resolvedScope.orgId);
      if (scopeRecord) {
        return {
          status: 200 as const,
          body: scopeToResponseBody(scopeRecord),
        };
      }

      // Fallback: no scope record yet — auto-create
      const scope = await ensureDefaultScope(userId);
      return { status: 200 as const, body: scopeToResponseBody(scope) };
    } catch (error) {
      if (isNotFound(error)) {
        // Auto-create default scope for new users via JIT Clerk org discovery
        try {
          const scope = await ensureDefaultScope(userId);
          return { status: 200 as const, body: scopeToResponseBody(scope) };
        } catch (ensureError) {
          if (isNotFound(ensureError)) {
            return createErrorResponse("NOT_FOUND", ensureError.message);
          }
          throw ensureError;
        }
      }
      throw error;
    }
  },

  /**
   * POST /api/scope - Create a scope
   */
  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId } = authCtx;

    const { slug } = body;

    log.debug("creating scope", { userId, slug });

    try {
      // Resolve orgId from user's Clerk org memberships
      const unmatchedOrg = await resolveUnmatchedClerkOrg(userId);

      if (!unmatchedOrg) {
        return createErrorResponse(
          "BAD_REQUEST",
          "No available Clerk organization to associate with this scope",
        );
      }

      const scope = await createScope(userId, slug, {
        orgId: unmatchedOrg.organization.id,
      });

      return { status: 201 as const, body: scopeToResponseBody(scope) };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", error.message);
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

    // TODO: 5b-5 — updateScopeSlug still needs scope UUID, query scopes table
    const scopeRecord = await getScopeByOrgId(resolvedScope.orgId);
    if (!scopeRecord) {
      return createErrorResponse("NOT_FOUND", "Scope not found");
    }

    try {
      const scope = await updateScopeSlug(scopeRecord.id, slug, userId, force);

      return { status: 200 as const, body: scopeToResponseBody(scope) };
    } catch (error) {
      if (isBadRequest(error)) {
        // Check if it's a conflict error (slug already exists)
        if (error.message.includes("already exists")) {
          return {
            status: 409 as const,
            body: {
              error: { message: error.message, code: "CONFLICT" },
            },
          };
        }
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      if (isForbidden(error)) {
        return createErrorResponse("FORBIDDEN", error.message);
      }
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", error.message);
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

export { handler as GET, handler as POST, handler as PUT };
