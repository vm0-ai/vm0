import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroBillingCheckoutContract,
  zeroBillingInvoicesContract,
  zeroBillingPortalContract,
} from "@vm0/api-contracts/contracts/zero-billing";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockListStripeInvoices } from "../../external/stripe-client";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const APP_ORIGIN = "http://app.localhost:3002";
const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const TEST_PRICE_CUSTOM_CREDITS = "price_test_custom_credits";

interface BillingCustomerFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly stripeCustomerId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function checkoutClient() {
  return setupApp({ context })(zeroBillingCheckoutContract);
}

function portalClient() {
  return setupApp({ context })(zeroBillingPortalContract);
}

function invoicesClient() {
  return setupApp({ context })(zeroBillingInvoicesContract);
}

function configureBillingEnv(): void {
  mockEnv("STRIPE_SECRET_KEY", "sk_test_billing");
  mockOptionalEnv("STRIPE_SECRET_KEY", "sk_test_billing");
  mockEnv("APP_URL", APP_ORIGIN);
  mockEnv(
    "ZERO_PRICE",
    JSON.stringify({
      pro: [TEST_PRICE_PRO],
      team: [TEST_PRICE_TEAM],
      customCredits: [TEST_PRICE_CUSTOM_CREDITS],
    }),
  );
}

async function createBillingCustomer(): Promise<BillingCustomerFixture> {
  configureBillingEnv();
  const fixture = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  context.mocks.stripe.customers.create.mockResolvedValueOnce({
    id: fixture.stripeCustomerId,
  });
  context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
    url: "https://checkout.stripe.com/session/customer-setup",
  });

  const checkout = await accept(
    checkoutClient().create({
      body: {
        tier: "pro",
        successUrl: `${APP_ORIGIN}/billing?billing=success`,
        cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
      },
      headers: authHeaders(),
    }),
    [200],
  );

  expect(checkout.body.url).toBe(
    "https://checkout.stripe.com/session/customer-setup",
  );
  expect(context.mocks.stripe.customers.create).toHaveBeenLastCalledWith({
    metadata: { orgId: fixture.orgId },
  });

  return fixture;
}

async function rawPortalRequest(body: object): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/zero/billing/portal", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("/api/zero/billing portal and invoices BDD", () => {
  it("enforces portal auth, configuration, body, admin, and origin boundaries", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const missingStripe = await accept(
      portalClient().create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: authHeaders(),
      }),
      [503],
    );

    expect(missingStripe.body).toStrictEqual({
      error: {
        message: "Billing not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });

    configureBillingEnv();
    const unauthenticated = await accept(
      portalClient().create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: {},
      }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const missingReturnUrl = await rawPortalRequest({});
    const invalidReturnUrl = await accept(
      portalClient().create({
        body: { returnUrl: "not-a-url" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(missingReturnUrl.status).toBe(400);
    await expect(missingReturnUrl.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(invalidReturnUrl.body.error.code).toBe("BAD_REQUEST");

    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const nonAdmin = await accept(
      portalClient().create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });

    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );
    const wrongOrigin = await accept(
      portalClient().create({
        body: { returnUrl: "https://evil.example.com/settings/billing" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(wrongOrigin.body).toStrictEqual({
      error: {
        message: "returnUrl must match the platform origin",
        code: "BAD_REQUEST",
      },
    });
  });

  it("creates a billing customer through checkout, then opens a portal session", async () => {
    const fixture = await createBillingCustomer();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValueOnce({
      url: "https://billing.stripe.com/session/test",
    });

    const portal = await accept(
      portalClient().create({
        body: { returnUrl: `${APP_ORIGIN}/settings/billing` },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(portal.body).toStrictEqual({
      url: "https://billing.stripe.com/session/test",
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenLastCalledWith({
      customer: fixture.stripeCustomerId,
      return_url: `${APP_ORIGIN}/settings/billing`,
    });
  });

  it("lists invoices for checkout-created customers and handles empty invoice states", async () => {
    const unauthenticated = await accept(
      invoicesClient().get({ headers: {} }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noActiveOrg = await accept(
      invoicesClient().get({ headers: authHeaders() }),
      [401],
    );

    expect(noActiveOrg.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const nonAdmin = await accept(
      invoicesClient().get({ headers: authHeaders() }),
      [403],
    );

    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can view invoices",
        code: "FORBIDDEN",
      },
    });

    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );
    mockListStripeInvoices(() => {
      throw new Error("Stripe invoices should not be listed without customer");
    });
    const noCustomer = await accept(
      invoicesClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(noCustomer.body).toStrictEqual({ invoices: [] });

    const fixture = await createBillingCustomer();
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

    const invoices = await accept(
      invoicesClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(receivedCustomerId).toBe(fixture.stripeCustomerId);
    expect(invoices.body).toStrictEqual({
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

    const emptyFixture = await createBillingCustomer();
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId, "org:admin");
    mockListStripeInvoices(() => {
      return Promise.resolve([]);
    });
    const emptyInvoices = await accept(
      invoicesClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(emptyInvoices.body).toStrictEqual({ invoices: [] });
  });
});
