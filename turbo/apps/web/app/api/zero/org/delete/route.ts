import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroOrgDeleteContract } from "@vm0/api-contracts/contracts/zero-org";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { deleteOrg } from "../../../../../src/lib/zero/org/org-member-service";
import { getOrgNameAndSlug } from "../../../../../src/lib/auth/org-cache";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "../../../../../src/lib/shared/errors";

const router = tsr.router(zeroOrgDeleteContract, {
  delete: async ({ headers, body }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const { org, member } = await resolveOrg(authCtx);
      const orgData = await getOrgNameAndSlug(org.orgId);

      // Verify the slug matches as a safety check
      if (body.slug !== orgData.slug) {
        return createErrorResponse(
          "BAD_REQUEST",
          "Organization name does not match",
        );
      }

      await deleteOrg(authCtx.userId, org.orgId, member.role);
      return {
        status: 200 as const,
        body: { message: "Organization deleted" },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      if (isForbidden(error)) {
        return createErrorResponse(
          "FORBIDDEN",
          "Only admins can delete the organization",
        );
      }
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroOrgDeleteContract, router, {
  routeName: "zero.org.delete",
});

export { handler as POST };
