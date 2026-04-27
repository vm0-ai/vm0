import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroBillingCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  createCheckoutSession,
  activePriceId,
} from "../../../../../src/lib/zero/billing/billing-service";

const router = tsr.router(zeroBillingCheckoutContract, {
  create: async ({ body, headers }) => {
    initServices();

    const { STRIPE_SECRET_KEY, NEXT_PUBLIC_APP_URL } = env();

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

    const appOrigin = new URL(NEXT_PUBLIC_APP_URL).origin;
    if (
      new URL(body.successUrl).origin !== appOrigin ||
      new URL(body.cancelUrl).origin !== appOrigin
    ) {
      return createErrorResponse(
        "BAD_REQUEST",
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    const priceId = activePriceId(body.tier);
    if (!priceId) {
      return createErrorResponse(
        "BAD_REQUEST",
        `Price not configured for ${body.tier} tier`,
      );
    }

    const url = await createCheckoutSession(
      org.orgId,
      priceId,
      body.successUrl,
      body.cancelUrl,
    );

    return { status: 200 as const, body: { url } };
  },
});

const handler = createHandler(zeroBillingCheckoutContract, router, {
  routeName: "zero.billing.checkout",
});

export { handler as POST };
