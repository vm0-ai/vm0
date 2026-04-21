import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  zeroBillingAutoRechargeContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  getAutoRechargeConfig,
  updateAutoRechargeConfig,
} from "../../../../../src/lib/zero/billing/billing-service";

const router = tsr.router(zeroBillingAutoRechargeContract, {
  get: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const config = await getAutoRechargeConfig(org.orgId);

    return { status: 200 as const, body: config };
  },

  update: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only org admins can update auto-recharge settings",
      );
    }

    const result = await updateAutoRechargeConfig(org.orgId, org.tier, body);

    if (!result.ok) {
      return createErrorResponse("BAD_REQUEST", result.error);
    }

    return { status: 200 as const, body: result.data };
  },
});

const handler = createHandler(zeroBillingAutoRechargeContract, router, {
  routeName: "zero.billing.auto-recharge",
});

export { handler as GET, handler as PUT };
