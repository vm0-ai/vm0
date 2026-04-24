import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroOrgInviteContract } from "@vm0/core/contracts/zero-org-members";
import { createErrorResponse } from "@vm0/core/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  inviteMember,
  revokeInvitation,
} from "../../../../../src/lib/zero/org/org-member-service";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "../../../../../src/lib/shared/errors";

const router = tsr.router(zeroOrgInviteContract, {
  invite: async ({ headers, body }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org, member } = await resolveOrg(authCtx);
      await inviteMember(
        authCtx.userId,
        org.orgId,
        member.role,
        body.email,
        body.role,
      );
      return {
        status: 200 as const,
        body: { message: `Invitation sent to ${body.email}` },
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

  revoke: async ({ headers, body }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org, member } = await resolveOrg(authCtx);
      await revokeInvitation(org.orgId, member.role, body.invitationId);
      return {
        status: 200 as const,
        body: { message: "Invitation revoked" },
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

const handler = createHandler(zeroOrgInviteContract, router, {
  routeName: "zero.org.invite",
});

export { handler as POST, handler as DELETE };
