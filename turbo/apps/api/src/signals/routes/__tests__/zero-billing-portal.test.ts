import { randomUUID } from "node:crypto";

import { zeroBillingPortalContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockStripeClient } from "../../external/stripe-client";
import {
  deleteInvoicesOrg$,
  seedInvoicesOrg$,
  type InvoicesOrgFixture,
} from "./helpers/zero-billing-invoices";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const APP_ORIGIN = "http://app.localhost:3002";

describe("POST /api/zero/billing/portal", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  it("returns portal URL on success", async () => {
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        { stripeCustomerId: `cus-portal-${randomUUID().slice(0, 8)}` },
        context.signal,
      ),
    );
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockStripeClient(
      context.mocks.stripe as unknown as Parameters<typeof mockStripeClient>[0],
    );
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/session/test",
    });

    const client = setupApp({ context })(zeroBillingPortalContract);
    const response = await accept(
      client.create({
        body: { returnUrl: `${APP_ORIGIN}/settings/billing` },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://billing.stripe.com/session/test",
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: fixture.stripeCustomerId,
      return_url: `${APP_ORIGIN}/settings/billing`,
    });
  });
});
