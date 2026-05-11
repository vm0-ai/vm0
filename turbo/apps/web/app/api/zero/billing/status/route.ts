import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
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
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

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
        creditGrants: status.creditGrants.map((record) => {
          return {
            ...record,
            createdAt: record.createdAt.toISOString(),
            expiresAt: record.expiresAt.toISOString(),
          };
        }),
      },
    };
  },
});

const handler = createHandler(zeroBillingStatusContract, router, {
  routeName: "zero.billing.status",
});

export { handler as GET };
