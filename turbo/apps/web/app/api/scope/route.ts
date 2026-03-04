import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import { scopeContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import {
  createUserScope,
  updateScopeSlug,
} from "../../../src/lib/scope/scope-service";
import { resolveScope } from "../../../src/lib/scope/resolve-scope";
import { logger } from "../../../src/lib/logger";
import { isBadRequest, isForbidden, isNotFound } from "../../../src/lib/errors";

const log = logger("api:scope");

const router = tsr.router(scopeContract, {
  /**
   * GET /api/scope - Get current user's scope
   *
   * Returns the active scope based on the auth token:
   * - vm0_org_* token → org scope
   * - vm0_live_* token → personal scope
   */
  get: async ({ headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    try {
      const { scope } = await resolveScope(userId, headers.authorization);

      return {
        status: 200 as const,
        body: {
          id: scope.id,
          slug: scope.slug,
          type: scope.type,
          createdAt: scope.createdAt.toISOString(),
          updatedAt: scope.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse(
          "NOT_FOUND",
          "No scope configured. Set your scope with: vm0 scope set <slug>",
        );
      }
      throw error;
    }
  },

  /**
   * POST /api/scope - Create user's scope
   */
  create: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { slug } = body;

    log.debug("creating user scope", { userId, slug });

    try {
      const scope = await createUserScope(userId, slug);

      return {
        status: 201 as const,
        body: {
          id: scope.id,
          slug: scope.slug,
          type: scope.type,
          createdAt: scope.createdAt.toISOString(),
          updatedAt: scope.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        // Check if it's a conflict error (user already has scope)
        if (error.message.includes("already have a scope")) {
          return {
            status: 409 as const,
            body: {
              error: { message: error.message, code: "CONFLICT" },
            },
          };
        }
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      throw error;
    }
  },

  /**
   * PUT /api/scope - Update active scope slug
   *
   * Resolves the active scope based on the auth token:
   * - vm0_org_* token → updates org scope
   * - vm0_live_* token → updates personal scope
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
      ({ scope: existingScope } = await resolveScope(
        userId,
        headers.authorization,
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
        existingScope.id,
        slug,
        userId,
        force,
      );

      return {
        status: 200 as const,
        body: {
          id: scope.id,
          slug: scope.slug,
          type: scope.type,
          createdAt: scope.createdAt.toISOString(),
          updatedAt: scope.updatedAt.toISOString(),
        },
      };
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
