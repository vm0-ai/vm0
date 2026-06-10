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

// BDD migration of the legacy `zero-billing-portal.test.ts`.
// The 7 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// 503 chain (Stripe not configured → 503), (2) 401 + 400
// + 403 + 400 APP_URL origin chain (no auth → 401, missing
// returnUrl → 400, invalid returnUrl → 400, non-admin →
// 403, admin with mismatched origin → 400), (3) 200
// success chain (admin + valid returnUrl → 200 portal URL
// + Stripe billingPortal.sessions.create called with the
// right customer + return_url).
//
// The 503 chain is isolated because the route short-circuits
// on `optionalEnv("STRIPE_SECRET_KEY")` BEFORE the auth
// check, so chaining a 401 after a 503 would still return
// 503. The 200 success chain is isolated because it depends
// on the seeded org fixture.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const APP_ORIGIN = "http://app.localhost:3002";

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroBillingPortalContract);
}

const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
  return store.set(deleteInvoicesOrg$, fixture, context.signal);
});

describe("BDD POST /api/zero/billing/portal — 503 chain", () => {
  it("gwt-wt-wt: 503 when STRIPE_SECRET_KEY is not configured", async () => {
    // Given: Stripe is not configured + an authenticated
    // session.
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 503.
    const noStripe = await accept(
      client().create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: authHeaders(),
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
});

describe("BDD POST /api/zero/billing/portal — auth + 400 + 403 chain", () => {
  it("gwt-wt-wt: 401 no auth → 400 missing returnUrl → 400 invalid returnUrl → 403 non-admin → 400 admin returnUrl origin does not match APP_URL", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      client().create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: an authenticated session.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 400 missing returnUrl.
    const missingReturnUrl = await accept(
      client().create({
        body: {} as never,
        headers: authHeaders(),
      }),
      [400],
    );
    expect(missingReturnUrl.body.error).toBeDefined();

    // When + Then: 400 invalid returnUrl (not a URL).
    const invalidReturnUrl = await accept(
      client().create({
        body: { returnUrl: "not-a-url" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(invalidReturnUrl.body.error).toBeDefined();

    // Given: a non-admin org member.
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );

    // When + Then: 403.
    const nonAdmin = await accept(
      client().create({
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

    // Given: APP_URL set + an admin session.
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );

    // When + Then: 400 (returnUrl origin does not match APP_URL).
    const mismatchedOrigin = await accept(
      client().create({
        body: { returnUrl: "https://evil.example.com/settings/billing" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(mismatchedOrigin.body).toStrictEqual({
      error: {
        message: "returnUrl must match the platform origin",
        code: "BAD_REQUEST",
      },
    });
  });
});

describe("BDD POST /api/zero/billing/portal — 200 success chain", () => {
  it("gwt-wt-wt: 200 returns portal URL + Stripe billingPortal.sessions.create called with the right customer + return_url", async () => {
    // Given: an org with a Stripe customer id + an admin
    // session + a stubbed billingPortal.sessions.create
    // response.
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        { stripeCustomerId: `cus-portal-${randomUUID().slice(0, 8)}` },
        context.signal,
      ),
    );
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/session/test",
    });

    // When + Then: 200 with the portal URL.
    const response = await accept(
      client().create({
        body: { returnUrl: `${APP_ORIGIN}/settings/billing` },
        headers: authHeaders(),
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
