import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import { scopeContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import {
  getUserScopeByClerkId,
  createUserScope,
  updateScopeSlug,
} from "../../../src/lib/scope/scope-service";
import { logger } from "../../../src/lib/logger";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../src/lib/errors";

const log = logger("api:scope");

const router = tsr.router(scopeContract, {
  /**
   * GET /api/scope - Get current user's scope
   */
  get: async ({ headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const scope = await getUserScopeByClerkId(userId);
    if (!scope) {
      return createErrorResponse(
        "NOT_FOUND",
        "No scope configured. Set your scope with: vm0 scope set <slug>",
      );
    }

    return {
      status: 200 as const,
      body: {
        id: scope.id,
        slug: scope.slug,
        type: scope.type,
        displayName: scope.displayName,
        createdAt: scope.createdAt.toISOString(),
        updatedAt: scope.updatedAt.toISOString(),
      },
    };
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

    const { slug, displayName } = body;

    log.debug("creating user scope", { userId, slug });

    try {
      const scope = await createUserScope(userId, slug, displayName);

      return {
        status: 201 as const,
        body: {
          id: scope.id,
          slug: scope.slug,
          type: scope.type,
          displayName: scope.displayName,
          createdAt: scope.createdAt.toISOString(),
          updatedAt: scope.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof BadRequestError) {
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
   * PUT /api/scope - Update user's scope slug
   */
  update: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { slug, force } = body;

    log.debug("updating user scope", { userId, slug, force });

    // First get user's current scope
    const existingScope = await getUserScopeByClerkId(userId);
    if (!existingScope) {
      return createErrorResponse(
        "NOT_FOUND",
        "No scope configured. Set your scope with: vm0 scope set <slug>",
      );
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
          displayName: scope.displayName,
          createdAt: scope.createdAt.toISOString(),
          updatedAt: scope.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof BadRequestError) {
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
      if (error instanceof ForbiddenError) {
        return createErrorResponse("FORBIDDEN", error.message);
      }
      if (error instanceof NotFoundError) {
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
