import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the billing downgrade + restore rejections. An org
// with no Stripe subscription is a 409 either way; the funded transitions
// (downgrade/restore a real subscription) need a seeded Stripe subscription with
// no API surface (GAP-STRIPE-SUBSCRIPTION) and stay in the kept legacy. See
// `api.bdd.md` (CHAIN-BILLING-TIER-CHANGE-REJECTIONS).
const context = testContext();

describe("billing downgrade/restore rejections (API-first BDD)", () => {
  it("downgrade rejects auth, role, tier, missing subscription, and config", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.billingDowngrade.create({
        headers: {},
        body: { targetTier: "pro-suspend" },
      }),
      [401],
    );

    // Non-admin member.
    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.billingDowngrade.create({
        headers: SESSION_AUTH,
        body: { targetTier: "pro-suspend" },
      }),
      [403],
    );
    expect(member.body.error.message).toBe(
      "Only org admins can manage billing",
    );

    // Invalid target tier.
    api.actAsAdmin();
    const badTier = await accept(
      api.billingDowngrade.create({
        headers: SESSION_AUTH,
        body: { targetTier: "team" as "pro-suspend" },
      }),
      [400],
    );
    expect(badTier.body.error.code).toBe("BAD_REQUEST");

    // An org with no subscription cannot be downgraded.
    const noSub = await accept(
      api.billingDowngrade.create({
        headers: SESSION_AUTH,
        body: { targetTier: "pro-suspend" },
      }),
      [409],
    );
    expect(noSub.body.error.message).toBe("Org has no active subscription");

    // Stripe is not configured (env-mutating, done last).
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    const noStripe = await accept(
      api.billingDowngrade.create({
        headers: SESSION_AUTH,
        body: { targetTier: "pro-suspend" },
      }),
      [503],
    );
    expect(noStripe.body.error.message).toBe("Billing not configured");
  });

  it("restore rejects auth, role, missing subscription, and config", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.billingRestore.create({ headers: {}, body: {} }), [401]);

    // Non-admin member.
    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.billingRestore.create({ headers: SESSION_AUTH, body: {} }),
      [403],
    );
    expect(member.body.error.message).toBe(
      "Only org admins can manage billing",
    );

    // An org with no subscription has nothing to restore.
    api.actAsAdmin();
    const noSub = await accept(
      api.billingRestore.create({ headers: SESSION_AUTH, body: {} }),
      [409],
    );
    expect(noSub.body.error.message).toBe("Org has no active subscription");

    // Stripe is not configured (env-mutating, done last).
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    const noStripe = await accept(
      api.billingRestore.create({ headers: SESSION_AUTH, body: {} }),
      [503],
    );
    expect(noStripe.body.error.message).toBe("Billing not configured");
  });
});
