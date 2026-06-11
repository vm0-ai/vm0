import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the billing status auth, capability and
// no-org-metadata cases. A fresh org has no `org_metadata` row, so the status
// falls back to the `pro-suspend` default with no subscription. The seeded
// free-tier / subscribed / scheduled-downgrade / cancelAtPeriodEnd and
// credit-expiry segment breakdowns need seeded Stripe subscription + credit
// ledger state (GAP-STRIPE-SUBSCRIPTION / GAP-RUN-CREDITS) and stay in the kept
// legacy. See `api.bdd.md` (CHAIN-BILLING-STATUS-REJECTIONS).
const context = testContext();

describe("billing status rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less / capability-less callers and reports the default tier for a fresh org", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.billingStatus.get({ headers: {} }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(api.billingStatus.get({ headers: SESSION_AUTH }), [401]);

    // A zero token without billing:read is forbidden.
    const forbidden = await accept(
      api.billingStatus.get({ headers: api.zeroAuth([]) }),
      [403],
    );
    expect(forbidden.body.error.message).toBe(
      "Missing required capability: billing:read",
    );

    // A fresh org has no org_metadata row, so it falls back to the default tier
    // with no subscription.
    api.actAsAdmin();
    const status = await accept(
      api.billingStatus.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(status.body.tier).toBe("pro-suspend");
    expect(status.body.hasSubscription).toBeFalsy();
    expect(status.body.subscriptionStatus).toBeNull();
    expect(status.body.currentPeriodEnd).toBeNull();
    expect(status.body.onboardingPaymentPending).toBeFalsy();
  });
});
