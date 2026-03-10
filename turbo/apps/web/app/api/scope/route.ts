import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import { scopeContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import {
  createScope,
  updateScopeSlug,
  isVm0Admin,
  ensureDefaultScope,
} from "../../../src/lib/scope/scope-service";
import { getUserEmail } from "../../../src/lib/auth/get-user-email";
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
   * Resolves the active scope via clerkOrgId from Clerk session,
   * or falls back to the user's default scope (first admin membership).
   */
  get: async ({ headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    try {
      const { scope } = await resolveScope(userId);

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

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { slug } = body;

    log.debug("creating scope", { userId, slug });

    try {
      // vm0-admin slug policy: allow vm0-prefixed slugs for admin users only
      let skipSlugValidation = false;
      if (slug.startsWith("vm0")) {
        const email = await getUserEmail(userId);
        if (!isVm0Admin(email)) {
          return createErrorResponse(
            "BAD_REQUEST",
            `Scope slug "${slug}" is reserved`,
          );
        }
        skipSlugValidation = true;
      }

      const scope = await createScope(userId, slug, { skipSlugValidation });

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
   * Resolves the active scope via clerkOrgId from Clerk session,
   * or falls back to the user's default scope (first admin membership).
   */
  update: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { slug, force } = body;

    log.debug("updating scope", { userId, slug, force });

    let existingScope;
    try {
      ({ scope: existingScope } = await resolveScope(userId));
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
        existingScope.id,
        slug,
        userId,
        force,
      );

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
