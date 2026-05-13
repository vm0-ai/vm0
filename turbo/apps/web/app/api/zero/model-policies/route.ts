import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { initServices } from "../../../../src/lib/init-services";
import {
  isAuthError,
  requireAuth,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  listOrgModelPoliciesForRoute,
  updateOrgModelPoliciesForRoute,
} from "../../../../src/lib/zero/model-policy/org-model-policy-management-service";

const router = tsr.router(zeroModelPoliciesMainContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { org } = await resolveOrg(authCtx);
    return {
      status: 200 as const,
      body: await listOrgModelPoliciesForRoute({
        orgId: org.orgId,
        userId: authCtx.userId,
      }),
    };
  },

  update: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { org, member } = await resolveOrg(authCtx);
    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only admins can manage model policies",
      );
    }

    const result = await updateOrgModelPoliciesForRoute({
      orgId: org.orgId,
      userId: authCtx.userId,
      policies: body.policies,
    });
    if (!result.ok) {
      return createErrorResponse("BAD_REQUEST", result.message);
    }

    return { status: 200 as const, body: result.data };
  },
});

const handler = createHandler(zeroModelPoliciesMainContract, router, {
  routeName: "zero.model-policies",
});

export { handler as GET, handler as PUT };
