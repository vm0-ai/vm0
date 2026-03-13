import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../src/lib/ts-rest-handler";
import { orgContract, createErrorResponse, ApiError } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getAuthContext } from "../../../src/lib/auth/get-user-id";
import { updateOrgSlug } from "../../../src/lib/org/org-service";
import { resolveOrg } from "../../../src/lib/org/resolve-org";
import type { ResolvedOrg } from "../../../src/lib/org/resolve-org";
import { logger } from "../../../src/lib/logger";
import { isBadRequest, isForbidden, isNotFound } from "../../../src/lib/errors";

const log = logger("api:org");

function resolvedOrgToResponse(resolved: ResolvedOrg) {
  return {
    id: resolved.orgId,
    slug: resolved.slug,
    tier: resolved.tier,
  };
}

const router = tsr.router(orgContract, {
  /**
   * GET /api/org - Get current user's default org
   *
   * Resolves the active org via orgId from Clerk session,
   * or falls back to the user's default org (first admin membership).
   */
  get: async ({ headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    try {
      const { org: resolvedOrg } = await resolveOrg(
        userId,
        null,
        null,
        tokenOrgId,
      );

      return {
        status: 200 as const,
        body: resolvedOrgToResponse(resolvedOrg),
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },

  /**
   * PUT /api/org - Update active org slug
   *
   * Resolves the active org via orgId from Clerk session,
   * or falls back to the user's default org (first admin membership).
   */
  update: async ({ body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    const { slug, force } = body;

    log.debug("updating org", { userId, slug, force });

    let resolvedOrg;
    try {
      ({ org: resolvedOrg } = await resolveOrg(userId, null, null, tokenOrgId));
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse(
          "NOT_FOUND",
          "No org configured. Set your org with: vm0 org set <slug>",
        );
      }
      throw error;
    }

    try {
      const org = await updateOrgSlug(resolvedOrg.orgId, slug, userId, force);

      return { status: 200 as const, body: resolvedOrgToResponse(org) };
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
 * Custom error handler for org API
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

const handler = createHandler(orgContract, router, {
  errorHandler,
});

export { handler as GET, handler as PUT };
