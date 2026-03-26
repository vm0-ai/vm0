import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroBillingCheckoutContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import {
  createCheckoutSession,
  activePriceId,
} from "../../../../../src/lib/billing/billing-service";

const router = tsr.router(zeroBillingCheckoutContract, {
  create: async ({ body, headers }, { request }) => {
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

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);
    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only org admins can manage billing",
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
      org.slug,
      priceId,
      body.successUrl,
      body.cancelUrl,
    );

    return { status: 200 as const, body: { url } };
  },
});

const handler = createHandler(zeroBillingCheckoutContract, router, {
  errorHandler: createSafeErrorHandler("zero-billing-checkout"),
});

export { handler as POST };
