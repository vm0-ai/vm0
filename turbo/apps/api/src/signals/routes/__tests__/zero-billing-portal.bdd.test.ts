import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the billing portal's pre-Stripe rejections. The
// funded success path opens a Stripe portal for the org's existing Stripe
// customer, which requires a seeded `stripeCustomerId` with no API surface to
// create (GAP-STRIPE-CUSTOMER); it stays in the kept legacy
// (`zero-billing-portal.test.ts`). Everything here is rejected before that. See
// `api.bdd.md` (CHAIN-BILLING-PORTAL).
const context = testContext();

const APP_ORIGIN = "http://app.localhost:3002";

describe("billing portal rejections (API-first BDD)", () => {
  it("requires authentication, an admin caller, and Stripe configuration", async () => {
    const api = createBddApi(context);

    // Unauthenticated (checked before anything else).
    const unauth = await accept(
      api.billingPortal.create({
        headers: {},
        body: { returnUrl: `${APP_ORIGIN}/settings` },
      }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // A non-admin member cannot open the portal.
    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.billingPortal.create({
        headers: SESSION_AUTH,
        body: { returnUrl: `${APP_ORIGIN}/settings` },
      }),
      [403],
    );
    expect(member.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });

    // Stripe is not configured (checked after auth + role) — done last because
    // it mutates the environment for the remainder of the test.
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    api.actAsAdmin();
    const noStripe = await accept(
      api.billingPortal.create({
        headers: SESSION_AUTH,
        body: { returnUrl: `${APP_ORIGIN}/settings` },
      }),
      [503],
    );
    expect(noStripe.body).toStrictEqual({
      error: {
        message: "Billing not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
  });

  it("validates the returnUrl", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Missing returnUrl.
    const missing = await accept(
      api.billingPortal.create({
        headers: SESSION_AUTH,
        body: {} as never,
      }),
      [400],
    );
    expect(missing.body.error).toBeDefined();

    // Malformed returnUrl.
    const malformed = await accept(
      api.billingPortal.create({
        headers: SESSION_AUTH,
        body: { returnUrl: "not-a-url" },
      }),
      [400],
    );
    expect(malformed.body.error).toBeDefined();

    // A returnUrl whose origin does not match the platform origin.
    mockEnv("APP_URL", APP_ORIGIN);
    const foreignOrigin = await accept(
      api.billingPortal.create({
        headers: SESSION_AUTH,
        body: { returnUrl: "https://evil.example.com/settings/billing" },
      }),
      [400],
    );
    expect(foreignOrigin.body).toStrictEqual({
      error: {
        message: "returnUrl must match the platform origin",
        code: "BAD_REQUEST",
      },
    });
  });
});
