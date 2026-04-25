import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  getOrgMembers,
  updateMemberRole,
  removeMember,
} from "../../../../../src/lib/zero/org/org-member-service";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "../../../../../src/lib/shared/errors";

const router = tsr.router(zeroOrgMembersContract, {
  members: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org } = await resolveOrg(authCtx);
      const status = await getOrgMembers(authCtx.userId, org.orgId);
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

  updateRole: async ({ headers, body }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org, member } = await resolveOrg(authCtx);
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

  removeMember: async ({ headers, body }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org, member } = await resolveOrg(authCtx);
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
  routeName: "zero.org.members",
});

export { handler as GET, handler as PATCH, handler as DELETE };
