import { randomUUID } from "node:crypto";

import { zeroBillingInvoicesContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockListStripeInvoices } from "../../external/stripe-client";
import {
  deleteInvoicesOrg$,
  seedInvoicesOrg$,
  type InvoicesOrgFixture,
} from "./helpers/zero-billing-invoices";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-billing-invoices.test.ts`.
// The 6 legacy `it()`s collapse into 2 BDD `it()`s: (1)
// auth boundary chain (401 unauth → 401 no-org → 403
// non-admin), (2) 200 success chain (admin with active
// subscription returns 2 invoices + Stripe called with
// the right customer id → admin with no Stripe customer
// returns empty list without calling Stripe → admin with
// a customer but no invoices returns empty list).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroBillingInvoicesContract);
}

const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
  return store.set(deleteInvoicesOrg$, fixture, context.signal);
});

describe("BDD GET /api/zero/billing/invoices — auth boundary", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 403 non-admin", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(client().get({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session that resolves to a user without
    // an org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(client().get({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a non-admin org member.
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    // When + Then: 403.
    const nonAdmin = await accept(
      client().get({ headers: authHeaders() }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can view invoices",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("BDD GET /api/zero/billing/invoices — 200 success chain", () => {
  it("gwt-wt-wt: 200 active subscription returns 2 invoices + Stripe called with the right customer → 200 no Stripe customer returns empty → 200 Stripe returns no invoices returns empty", async () => {
    // Given: an org with a Stripe customer id + an
    // active subscription + a stubbed list-invoices
    // response returning 2 paid invoices.
    const customerId = `cus-inv-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub-inv-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    let receivedCustomerId: string | null = null;
    mockListStripeInvoices((stripeCustomerId) => {
      receivedCustomerId = stripeCustomerId;
      return Promise.resolve([
        {
          id: "inv_001",
          number: "INV-2026-001",
          created: 1_740_000_000,
          amount_paid: 4000,
          status: "paid",
          hosted_invoice_url: "https://stripe.com/invoice/inv_001",
        },
        {
          id: "inv_002",
          number: "INV-2026-002",
          created: 1_737_400_000,
          amount_paid: 4000,
          status: "paid",
          hosted_invoice_url: "https://stripe.com/invoice/inv_002",
        },
      ]);
    });

    // When + Then: 200 with the 2 invoices.
    const response = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );
    expect(receivedCustomerId).toBe(customerId);
    expect(response.body).toStrictEqual({
      invoices: [
        {
          id: "inv_001",
          number: "INV-2026-001",
          date: 1_740_000_000,
          amount: 4000,
          status: "paid",
          hostedInvoiceUrl: "https://stripe.com/invoice/inv_001",
        },
        {
          id: "inv_002",
          number: "INV-2026-002",
          date: 1_737_400_000,
          amount: 4000,
          status: "paid",
          hostedInvoiceUrl: "https://stripe.com/invoice/inv_002",
        },
      ],
    });

    // Given: a fresh org without a Stripe customer id.
    const noCustomerFx = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(noCustomerFx.userId, noCustomerFx.orgId, "org:admin");
    mockListStripeInvoices(() => {
      throw new Error("Stripe invoices should not be listed without customer");
    });

    // When + Then: 200 empty list.
    const noCustomer = await accept(
      client().get({ headers: authHeaders() }),
      [200],
    );
    expect(noCustomer.body).toStrictEqual({ invoices: [] });

    // Given: a fresh org with a Stripe customer id but
    // Stripe returns no invoices.
    const emptyFx = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: `cus-empty-${randomUUID().slice(0, 8)}`,
          stripeSubscriptionId: `sub-empty-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(emptyFx.userId, emptyFx.orgId, "org:admin");
    mockListStripeInvoices(() => {
      return Promise.resolve([]);
    });

    // When + Then: 200 empty list.
    const empty = await accept(client().get({ headers: authHeaders() }), [200]);
    expect(empty.body).toStrictEqual({ invoices: [] });
  });
});
