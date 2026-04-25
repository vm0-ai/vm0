import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroOrgMembershipRequestsContract } from "@vm0/api-contracts/contracts/zero-org-members";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  acceptMembershipRequest,
  rejectMembershipRequest,
} from "../../../../../src/lib/zero/org/org-member-service";
import {
  isBadRequest,
  isForbidden,
} from "../../../../../src/lib/shared/errors";

const router = tsr.router(zeroOrgMembershipRequestsContract, {
  accept: async ({ headers, body }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org, member } = await resolveOrg(authCtx);
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
      throw error;
    }
  },

  reject: async ({ headers, body }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org, member } = await resolveOrg(authCtx);
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
      throw error;
    }
  },
});

const handler = createHandler(zeroOrgMembershipRequestsContract, router, {
  routeName: "zero.org.membership-requests",
});

export { handler as POST, handler as DELETE };
