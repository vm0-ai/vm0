import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroBillingDowngradeContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { downgradeSubscription } from "../../../../../src/lib/zero/billing/billing-service";

const router = tsr.router(zeroBillingDowngradeContract, {
  create: async ({ body, headers }) => {
    initServices();

    const { STRIPE_SECRET_KEY } = env();

    if (!STRIPE_SECRET_KEY) {
      return createErrorResponse(
        "PROVIDER_UNAVAILABLE",
        "Billing not configured",
      );
    }

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);
    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only org admins can manage billing",
      );
    }

    const result = await downgradeSubscription(org.orgId, body.targetTier);

    if (!result.ok) {
      if (result.reason === "no_subscription") {
        return createErrorResponse(
          "CONFLICT",
          "Org has no active subscription",
        );
      }
      return createErrorResponse(
        "BAD_REQUEST",
        `Cannot downgrade from ${result.currentTier} to ${result.targetTier}: target tier is same or higher`,
      );
    }

    return {
      status: 200 as const,
      body: { success: true, effectiveDate: result.effectiveDate },
    };
  },
});

const handler = createHandler(zeroBillingDowngradeContract, router, {
  routeName: "zero.billing.downgrade",
});

export { handler as POST };
