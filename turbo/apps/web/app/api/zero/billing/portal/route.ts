import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroBillingPortalContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { createBillingPortalSession } from "../../../../../src/lib/zero/billing/billing-service";

const router = tsr.router(zeroBillingPortalContract, {
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

    const url = await createBillingPortalSession(org.orgId, body.returnUrl);

    return { status: 200 as const, body: { url } };
  },
});

const handler = createHandler(zeroBillingPortalContract, router, {
  routeName: "zero.billing.portal",
});

export { handler as POST };
