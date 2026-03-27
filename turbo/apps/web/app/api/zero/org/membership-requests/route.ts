import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import {
  zeroOrgMembershipRequestsContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import {
  acceptMembershipRequest,
  rejectMembershipRequest,
} from "../../../../../src/lib/org/org-member-service";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "../../../../../src/lib/errors";

const router = tsr.router(zeroOrgMembershipRequestsContract, {
  list: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      await resolveOrg(authCtx, orgSlug);
      // Membership requests are already returned in the members endpoint
      return {
        status: 200 as const,
        body: { message: "Use GET /api/zero/org/members for full data" },
      };
    } catch (error) {
      if (isForbidden(error)) {
        return createErrorResponse("FORBIDDEN", "Access denied");
      }
      throw error;
    }
  },

  accept: async ({ headers, body }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org, member } = await resolveOrg(authCtx, orgSlug);
      await acceptMembershipRequest(org.orgId, member.role, body.requestId);
      return {
        status: 200 as const,
        body: { message: "Membership request accepted" },
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

  reject: async ({ headers, body }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org, member } = await resolveOrg(authCtx, orgSlug);
      await rejectMembershipRequest(org.orgId, member.role, body.requestId);
      return {
        status: 200 as const,
        body: { message: "Membership request rejected" },
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

const handler = createHandler(zeroOrgMembershipRequestsContract, router, {
  errorHandler: createSafeErrorHandler("zero-org-membership-requests"),
});

export { handler as GET, handler as POST, handler as DELETE };
