import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroBillingStatusContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { getBillingStatus } from "../../../../../src/lib/billing/billing-service";

const router = tsr.router(zeroBillingStatusContract, {
  get: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    const status = await getBillingStatus(org.orgId);

    return {
      status: 200 as const,
      body: {
        ...status,
        currentPeriodEnd: status.currentPeriodEnd?.toISOString() ?? null,
      },
    };
  },
});

const handler = createHandler(zeroBillingStatusContract, router, {
  errorHandler: createSafeErrorHandler("zero-billing-status"),
});

export { handler as GET };
