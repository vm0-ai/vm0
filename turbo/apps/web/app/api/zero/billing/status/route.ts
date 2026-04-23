import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroBillingStatusContract } from "@vm0/core/contracts/zero-billing";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getBillingStatus } from "../../../../../src/lib/zero/billing/billing-service";

const router = tsr.router(zeroBillingStatusContract, {
  get: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const status = await getBillingStatus(org.orgId);

    return {
      status: 200 as const,
      body: {
        ...status,
        currentPeriodEnd: status.currentPeriodEnd?.toISOString() ?? null,
        creditExpiry: {
          expiringNextCycle: status.creditExpiry.expiringNextCycle,
          nextExpiryDate:
            status.creditExpiry.nextExpiryDate?.toISOString() ?? null,
        },
      },
    };
  },
});

const handler = createHandler(zeroBillingStatusContract, router, {
  routeName: "zero.billing.status",
});

export { handler as GET };
