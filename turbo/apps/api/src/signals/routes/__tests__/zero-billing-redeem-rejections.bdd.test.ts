import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the one-time campaign redeem auth cases. A real
// redeem (campaign-misconfigured / Stripe session create / already-redeemed)
// needs seeded campaign env config plus a Stripe customer + session
// (GAP-STRIPE-CUSTOMER) and stays in the kept legacy. See `api.bdd.md`
// (CHAIN-BILLING-REDEEM-REJECTIONS).
const context = testContext();

function redeemBody(): { successUrl: string; cancelUrl: string } {
  return {
    successUrl: "https://app.vm0.ai/redeem/ZERO100?stripe=success",
    cancelUrl: "https://app.vm0.ai/redeem/ZERO100",
  };
}

describe("billing campaign redeem rejections (API-first BDD)", () => {
  it("rejects unauthenticated and org-less callers", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.billingRedeem.create({
        params: { campaign: "ZERO100" },
        body: redeemBody(),
        headers: {},
      }),
      [401],
    );

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.billingRedeem.create({
        params: { campaign: "ZERO100" },
        body: redeemBody(),
        headers: SESSION_AUTH,
      }),
      [401],
    );
  });
});
