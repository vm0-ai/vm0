import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroOrgContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { updateOrg } from "../../../../src/lib/zero/org/org-service";
import { getOrgNameAndSlug } from "../../../../src/lib/auth/org-cache";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "../../../../src/lib/shared/errors";

const router = tsr.router(zeroOrgContract, {
  get: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org: resolvedOrg, member } = await resolveOrg(authCtx);
      const orgData = await getOrgNameAndSlug(resolvedOrg.orgId);

      return {
        status: 200 as const,
        body: {
          id: resolvedOrg.orgId,
          slug: orgData.slug,
          name: orgData.name,
          tier: resolvedOrg.tier,
          role: member.role,
          createdBy: orgData.createdBy,
        },
      };
    } catch (error) {
      if (isNotFound(error) || isBadRequest(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },

  update: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    try {
      const { org: resolvedOrg } = await resolveOrg(authCtx);
      const updatedOrg = await updateOrg(resolvedOrg.orgId, userId, {
        slug: body.slug,
        name: body.name,
        force: body.force,
      });

      return {
        status: 200 as const,
        body: {
          id: updatedOrg.orgId,
          slug: updatedOrg.slug,
          name: updatedOrg.name,
          tier: updatedOrg.tier,
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        if (error.message.includes("already exists")) {
          return createErrorResponse("CONFLICT", error.message);
        }
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      if (isForbidden(error)) {
        return createErrorResponse("FORBIDDEN", "Access denied");
      }
      if (isNotFound(error)) {
        return createErrorResponse(
          "NOT_FOUND",
          "No org configured. Set your org with: zero org set <slug>",
        );
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroOrgContract, router, {
  errorHandler: createSafeErrorHandler("zero-org"),
});

export { handler as GET, handler as PUT };
