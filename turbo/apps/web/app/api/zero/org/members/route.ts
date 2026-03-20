import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroOrgMembersContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import {
  getOrgMembers,
  updateMemberRole,
  removeMember,
} from "../../../../../src/lib/org/org-member-service";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "../../../../../src/lib/errors";

const router = tsr.router(zeroOrgMembersContract, {
  members: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org } = await resolveOrg(authCtx, orgSlug);
      const status = await getOrgMembers(authCtx.userId, org.orgId, org.slug);
      return { status: 200 as const, body: status };
    } catch (error) {
      if (isBadRequest(error)) {
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

  updateRole: async ({ headers, body }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org, member } = await resolveOrg(authCtx, orgSlug);
      await updateMemberRole(
        authCtx.userId,
        org.orgId,
        member.role,
        body.email,
        body.role,
      );
      return {
        status: 200 as const,
        body: { message: `Updated role for ${body.email}` },
      };
    } catch (error) {
      if (isBadRequest(error)) {
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

  removeMember: async ({ headers, body }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org, member } = await resolveOrg(authCtx, orgSlug);
      await removeMember(authCtx.userId, org.orgId, member.role, body.email);
      return {
        status: 200 as const,
        body: { message: `Removed ${body.email} from org` },
      };
    } catch (error) {
      if (isBadRequest(error)) {
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

const handler = createHandler(zeroOrgMembersContract, router, {
  errorHandler: createSafeErrorHandler("zero-org-members"),
});

export { handler as GET, handler as PATCH, handler as DELETE };
