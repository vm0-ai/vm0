import { describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
  isFirewallConnectorType,
} from "../index";
import {
  stripeCategories,
  stripeCategoryOrder,
  stripeDefaultAllowed,
  stripeGenerationStats,
} from "../stripe.generated";

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

function expectStripeMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  const matches = findMatchingPermissions(
    method,
    path,
    getConnectorFirewall("stripe"),
  );
  expect([...matches].sort()).toStrictEqual([...permissionNames].sort());
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
        return new URL(api.base).hostname === "dashboard.stripe.com";
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
    expectStripeRule("payment_links_read", "GET /v1/payment_links");
    expectStripeRule(
      "payment_links_write",
      "POST /v1/payment_links/{payment_link}",
    );
    expectStripeRule(
      "billing_clock_read",
      "GET /v1/test_helpers/test_clocks/{test_clock}",
    );
    expectStripeRule(
      "billing_clock_write",
      "POST /v1/test_helpers/test_clocks/{test_clock}/advance",
    );
    expectStripeRule(
      "entitlement_read",
      "GET /v1/entitlements/active_entitlements/{id}",
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
    expectStripeRule("source_read", "GET /v1/customers/{customer}/cards");
    expectStripeRule(
      "source_read",
      "GET /v1/customers/{customer}/bank_accounts/{id}",
    );
    expectStripeRule("source_write", "POST /v1/customers/{customer}/sources");
    expectStripeRule(
      "source_write",
      "POST /v1/customers/{customer}/sources/{id}/verify",
    );
    expectStripeRule(
      "confirmation_token_client_write",
      "POST /v1/test_helpers/confirmation_tokens",
    );
  });

  it("uses OpenAPI resource IDs for Stripe restricted key resource permissions", () => {
    expectStripeRule(
      "forwarding_request_read",
      "GET /v1/forwarding/requests/{id}",
    );
    expectStripeRule(
      "forwarding_request_write",
      "POST /v1/forwarding/requests",
    );
    expectStripeRule("climate_order_read", "GET /v1/climate/orders");
    expectStripeRule("climate_order_write", "POST /v1/climate/orders");
    expectStripeRule(
      "identity_verification_session_write",
      "POST /v1/identity/verification_sessions",
    );
    expectStripeRule(
      "treasury_financial_account_read",
      "GET /v1/treasury/financial_accounts/{financial_account}",
    );
    expectStripeRule(
      "treasury_financial_account_write",
      "POST /v1/treasury/financial_accounts",
    );
  });

  it("maps legacy ambiguous Stripe unions into multiple resource permissions", () => {
    expectStripeRule(
      "external_account_write",
      "POST /v1/accounts/{account}/external_accounts",
    );
    expectStripeRule(
      "card_write",
      "POST /v1/accounts/{account}/external_accounts",
    );
    expectStripeRule(
      "bank_account_write",
      "POST /v1/accounts/{account}/external_accounts",
    );
    expectStripeMatches("POST", "/v1/accounts/acct_123/external_accounts", [
      "bank_account_write",
      "card_write",
      "external_account_write",
    ]);

    expectStripeRule("source_write", "POST /v1/customers/{customer}/cards");
    expectStripeRule("card_write", "POST /v1/customers/{customer}/cards");
    expectStripeRule(
      "payment_source_write",
      "POST /v1/customers/{customer}/cards",
    );
    expectStripeMatches("POST", "/v1/customers/cus_123/cards", [
      "account_write",
      "bank_account_write",
      "card_write",
      "payment_source_write",
      "source_write",
    ]);

    expectStripeRule(
      "source_read",
      "GET /v1/customers/{customer}/sources/{id}",
    );
    expectStripeRule(
      "connected_account_read",
      "GET /v1/customers/{customer}/sources/{id}",
    );
    expectStripeMatches("GET", "/v1/customers/cus_123/sources/src_123", [
      "bank_account_read",
      "card_read",
      "connected_account_read",
      "payment_source_read",
      "source_read",
    ]);
  });

  it("uses official Stripe API v2 docs for resource permissions without OpenAPI resource IDs", () => {
    expectStripeRule("v2_core_account_read", "GET /v2/core/accounts/{id}");
    expectStripeRule("v2_core_account_write", "POST /v2/core/accounts/{id}");
    expectStripeRule(
      "v2_core_account_person_token_read",
      "GET /v2/core/accounts/{account_id}/person_tokens/{id}",
    );
    expectStripeRule(
      "v2_core_account_person_token_write",
      "POST /v2/core/accounts/{account_id}/person_tokens",
    );
    expectStripeRule(
      "webhook_write",
      "POST /v2/core/event_destinations/{id}/ping",
    );
    expectStripeRule(
      "billing_meter_event_write",
      "POST /v2/billing/meter_event_stream",
    );
    expectStripeRule(
      "product_catalog_import_read",
      "GET /v2/commerce/product_catalog/imports/{id}",
    );
  });

  it("reports generated mapping coverage with legacy ambiguous overrides", () => {
    const firewall = getConnectorFirewall("stripe");
    const permissionCount = firewall.apis.reduce((count, api) => {
      return count + (api.permissions?.length ?? 0);
    }, 0);

    expect(stripeGenerationStats.totalOperations).toBe(619);
    expect(stripeGenerationStats.mappedOperations).toBe(619);
    expect(stripeGenerationStats.docsMappedOperations).toBe(53);
    expect(stripeGenerationStats.openApiResourceMappedOperations).toBe(239);
    expect(stripeGenerationStats.legacyAmbiguousMappedOperations).toBe(16);
    expect(stripeGenerationStats.unmappedOperations).toBe(0);
    expect(stripeGenerationStats.ambiguousOperations).toBe(0);
    expect(stripeGenerationStats.permissionCount).toBe(236);
    expect(stripeGenerationStats.permissionCount).toBe(permissionCount);
  });

  it("groups Stripe permissions by product area", () => {
    expect(stripeCategories.customer_read).toBe("Core");
    expect(stripeCategories.invoice_write).toBe("Billing");
    expect(stripeCategories.forwarding_request_write).toBe("Payments");
    expect(stripeCategories.treasury_financial_account_write).toBe("Treasury");
    expect(stripeCategories.v2_core_account_write).toBe("Core");
    expect(stripeCategoryOrder).toContain("Core");
    expect(stripeCategoryOrder).toContain("Billing");
    expect(stripeCategoryOrder).toContain("Treasury");
  });

  it("defaults Stripe readonly permissions to allow", () => {
    const policy = getDefaultFirewallPolicies("stripe");

    expect(policy.policies.customer_read).toBe("allow");
    expect(policy.policies.charge_read).toBe("allow");
    expect(policy.policies.invoice_read).toBe("allow");
    expect(policy.policies.checkout_session_read).toBe("allow");
    expect(policy.policies.event_read).toBe("allow");
    expect(policy.policies.secret_read).toBe("allow");
    expect(policy.policies.financial_connections_account_read).toBe("allow");
    expect(policy.policies.identity_verification_report_read).toBe("allow");
    expect(policy.policies.treasury_financial_account_read).toBe("allow");
    expect(policy.policies.product_read).toBe("allow");
    expect(policy.policies.plan_read).toBe("allow");
    expect(policy.policies.coupon_read).toBe("allow");
    expect(policy.policies.payment_method_domain_read).toBe("allow");
    expect(policy.policies.tax_code_read).toBe("allow");
    expect(policy.policies.payment_intent_write).toBe("deny");
    expect(policy.policies.checkout_session_write).toBe("deny");
    expect(policy.unknownPolicy).toBe("allow");
  });

  it("generates Stripe default-allowed permissions from readonly rules", () => {
    const firewall = getConnectorFirewall("stripe");
    const readOnlyPermissions = firewall.apis.flatMap((api) => {
      return (api.permissions ?? [])
        .filter((permission) => {
          return permission.rules.every((rule) => {
            return rule.startsWith("GET ") || rule.startsWith("HEAD ");
          });
        })
        .map((permission) => {
          return permission.name;
        });
    });

    expect([...stripeDefaultAllowed].sort()).toStrictEqual(
      readOnlyPermissions.sort(),
    );
    expect(stripeDefaultAllowed).toHaveLength(125);
    expect(stripeDefaultAllowed).toContain("customer_read");
    expect(stripeDefaultAllowed).toContain("charge_read");
    expect(stripeDefaultAllowed).toContain("invoice_read");
    expect(stripeDefaultAllowed).toContain("event_read");
    expect(stripeDefaultAllowed).toContain("secret_read");
    expect(stripeDefaultAllowed).not.toContain("customer_write");
  });
});
