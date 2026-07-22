import { randomUUID } from "node:crypto";

import { zeroBillingPortalContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
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

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroBillingPortalContract);
    const response = await accept(
      client.create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: { authorization: "Bearer clerk-session" },
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

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroBillingPortalContract);

    const response = await accept(
      client.create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 400 when returnUrl is missing", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroBillingPortalContract);
    const response = await accept(
      client.create({
        body: {} as never,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toBeDefined();
  });

  it("returns 400 when returnUrl is not a valid URL", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroBillingPortalContract);
    const response = await accept(
      client.create({
        body: { returnUrl: "not-a-url" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toBeDefined();
  });

  it("returns 403 for a non-admin org member", async () => {
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );

    const client = setupApp({ context })(zeroBillingPortalContract);
    const response = await accept(
      client.create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });
  });

  it.each([
    `${APP_ORIGIN}/settings/billing`,
    "https://okou.ai/settings/billing",
    "https://console.okou.ai/settings/billing",
    "https://pr-22085-app.omby.ai/settings/billing",
  ])("returns portal URL to the allowed origin %s", async (returnUrl) => {
    const customerId = `cus-portal-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub-portal-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/session/test",
    });

    const client = setupApp({ context })(zeroBillingPortalContract);
    const response = await accept(
      client.create({
        body: { returnUrl },
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
      return_url: returnUrl,
    });
  });

  it.each([
    "https://evil.example.com/settings/billing",
    "https://okou.ai.evil.example/settings/billing",
    "https://pr-22085-app.vm6.ai/settings/billing",
  ])("returns 400 for the disallowed origin in %s", async (returnUrl) => {
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );

    const client = setupApp({ context })(zeroBillingPortalContract);
    const response = await accept(
      client.create({
        body: { returnUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "returnUrl must match the platform origin",
        code: "BAD_REQUEST",
      },
    });
  });
});
