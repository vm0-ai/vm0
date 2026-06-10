import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the billing-checkout rejections that fire before
// the Stripe price lookup: missing Stripe config, auth, body validation, and the
// admin role check. The funded success path and tier-transition cases need
// seeded org/Stripe state (current tier, customer, subscription) with no API
// surface (GAP-STRIPE-CUSTOMER / GAP-ORG-TIER) and stay in the kept legacy. See
// `api.bdd.md` (CHAIN-BILLING-CHECKOUT-REJECTIONS).
const context = testContext();

const APP_ORIGIN = "http://localhost:3002";

function checkoutBody(tier: "pro" | "team" = "pro") {
  return {
    tier,
    successUrl: `${APP_ORIGIN}/billing?billing=success`,
    cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
  };
}

describe("billing checkout rejections (API-first BDD)", () => {
  it("requires authentication, an org, an admin caller, and a valid tier", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.billingCheckout.create({ headers: {}, body: checkoutBody() }),
      [401],
    );

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.billingCheckout.create({
        headers: SESSION_AUTH,
        body: checkoutBody(),
      }),
      [401],
    );

    // A non-admin member cannot start checkout.
    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.billingCheckout.create({
        headers: SESSION_AUTH,
        body: checkoutBody(),
      }),
      [403],
    );
    expect(member.body.error).toStrictEqual({
      message: "Only org admins can manage billing",
      code: "FORBIDDEN",
    });

    // An invalid tier is rejected by request validation.
    api.actAsAdmin();
    const badTier = await accept(
      api.billingCheckout.create({
        headers: SESSION_AUTH,
        body: { ...checkoutBody(), tier: "enterprise" as "pro" },
      }),
      [400],
    );
    expect(badTier.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 503 when Stripe is not configured", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);

    const response = await accept(
      api.billingCheckout.create({
        headers: SESSION_AUTH,
        body: checkoutBody(),
      }),
      [503],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Billing not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
  });
});
