import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
  isFirewallConnectorType,
} from "../index";
import { stripeGenerationStats } from "../stripe.generated";

function getStripePermission(name: string) {
  const firewall = getConnectorFirewall("stripe");
  const permission = firewall.apis
    .flatMap((api) => {
      return api.permissions ?? [];
    })
    .find((candidate) => {
      return candidate.name === name;
    });

  if (!permission) {
    throw new Error(`Missing Stripe permission "${name}"`);
  }
  return permission;
}

function expectStripeRule(permissionName: string, rule: string): void {
  const permission = getStripePermission(permissionName);
  expect(permission.rules).toContain(rule);
}

describe("stripe firewall", () => {
  it("registers the Stripe firewall with API token auth", () => {
    expect(isFirewallConnectorType("stripe")).toBe(true);
    const firewall = getConnectorFirewall("stripe");

    expect(firewall.name).toBe("stripe");
    expect(firewall.apis).toHaveLength(1);
    expect(firewall.apis[0]).toMatchObject({
      base: "https://api.stripe.com",
      auth: {
        headers: {
          Authorization: "Bearer ${{ secrets.STRIPE_TOKEN }}",
        },
      },
    });
    expect(
      firewall.apis.some((api) => {
        return api.base.includes("dashboard.stripe.com");
      }),
    ).toBe(false);
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "STRIPE_TOKEN",
    ]);
  });

  it("exposes official Stripe permission names for representative resources", () => {
    expectStripeRule("customer_read", "GET /v1/customers");
    expectStripeRule("customer_write", "POST /v1/customers");
    expectStripeRule("payment_intent_read", "GET /v1/payment_intents/{intent}");
    expectStripeRule(
      "payment_intent_write",
      "POST /v1/payment_intents/{intent}/confirm",
    );
    expectStripeRule(
      "checkout_session_read",
      "GET /v1/checkout/sessions/{session}",
    );
    expectStripeRule("checkout_session_write", "POST /v1/checkout/sessions");
  });

  it("maps documented Stripe permission aliases without guessing ambiguous resources", () => {
    expectStripeRule("charge_read", "GET /v1/refunds");
    expectStripeRule("charge_write", "POST /v1/refunds");
    expectStripeRule(
      "customer_portal_read",
      "GET /v1/billing_portal/configurations",
    );
    expectStripeRule(
      "payment_records_write",
      "POST /v1/payment_records/report_payment",
    );
    expectStripeRule(
      "terminal_reader_read",
      "GET /v1/terminal/readers/{reader}",
    );
  });

  it("uses official Stripe API docs endpoint lists for rules without resource IDs", () => {
    expectStripeRule(
      "checkout_session_read",
      "GET /v1/checkout/sessions/{session}/line_items",
    );
    expectStripeRule(
      "credit_note_read",
      "GET /v1/credit_notes/{credit_note}/lines",
    );
    expectStripeRule("quote_read", "GET /v1/quotes/{quote}/pdf");
    expectStripeRule("source_write", "POST /v1/customers/{customer}/sources");
    expectStripeRule(
      "confirmation_token_client_write",
      "POST /v1/test_helpers/confirmation_tokens",
    );
  });

  it("reports generated mapping coverage without hiding unmapped operations", () => {
    const firewall = getConnectorFirewall("stripe");
    const permissionCount = firewall.apis.reduce((count, api) => {
      return count + (api.permissions?.length ?? 0);
    }, 0);

    expect(stripeGenerationStats.totalOperations).toBeGreaterThan(0);
    expect(stripeGenerationStats.mappedOperations).toBeGreaterThan(0);
    expect(stripeGenerationStats.docsMappedOperations).toBeGreaterThan(0);
    expect(stripeGenerationStats.unmappedOperations).toBeGreaterThan(0);
    expect(stripeGenerationStats.permissionCount).toBe(permissionCount);
  });

  it("keeps Stripe permissions default-allowed with unknown policy compatibility", () => {
    const policy = getDefaultFirewallPolicies("stripe");

    expect(policy.policies.customer_read).toBe("allow");
    expect(policy.policies.payment_intent_write).toBe("allow");
    expect(policy.policies.checkout_session_read).toBe("allow");
    expect(policy.unknownPolicy).toBe("allow");
  });
});
