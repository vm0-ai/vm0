import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { mockListStripeInvoices } from "../../external/stripe-client";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for billing invoices when there is nothing to bill. An
// org with no Stripe customer lists no invoices without ever calling Stripe; the
// funded cases (an org with a seeded Stripe customer + subscription) require a
// DB-seeded customer with no API surface (GAP-STRIPE-CUSTOMER) and stay in the
// kept legacy. See `api.bdd.md` (CHAIN-BILLING-INVOICES).
const context = testContext();

describe("billing invoices (API-first BDD)", () => {
  it("requires authentication, an active org, and an admin caller", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.billingInvoices.get({ headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // No active organization.
    api.actAsNoOrg();
    const noOrg = await accept(
      api.billingInvoices.get({ headers: SESSION_AUTH }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // A non-admin member cannot view invoices.
    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.billingInvoices.get({ headers: SESSION_AUTH }),
      [403],
    );
    expect(member.body).toStrictEqual({
      error: {
        message: "Only org admins can view invoices",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns an empty list when the org has no Stripe customer", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();
    mockListStripeInvoices(() => {
      throw new Error(
        "Stripe invoices should not be listed without a customer",
      );
    });

    const response = await accept(
      api.billingInvoices.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(response.body).toStrictEqual({ invoices: [] });
  });
});
