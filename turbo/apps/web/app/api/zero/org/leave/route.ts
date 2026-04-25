import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroOrgLeaveContract } from "@vm0/api-contracts/contracts/zero-org";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { leaveOrg } from "../../../../../src/lib/zero/org/org-member-service";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "../../../../../src/lib/shared/errors";

const router = tsr.router(zeroOrgLeaveContract, {
  leave: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org, member } = await resolveOrg(authCtx);
      await leaveOrg(authCtx.userId, org.orgId, member.role);
      return { status: 200 as const, body: { message: "Left org" } };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      if (isForbidden(error)) {
        return createErrorResponse(
          "FORBIDDEN",
          "Admins cannot leave the organization",
        );
      }
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroOrgLeaveContract, router, {
  routeName: "zero.org.leave",
});

export { handler as POST };
