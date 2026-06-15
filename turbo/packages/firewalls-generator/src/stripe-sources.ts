export const STRIPE_OPENAPI_URL =
  "https://raw.githubusercontent.com/stripe/openapi/master/latest/openapi.spec3.json";

export const STRIPE_PERMISSIONS_URL =
  "https://docs.stripe.com/stripe-apps/reference/permissions.md";

export const STRIPE_RESTRICTED_API_KEYS_URL =
  "https://docs.stripe.com/keys/restricted-api-keys.md";

// Supplemental sources are only for official Stripe docs that identify a
// resource/endpoint family not covered by the public Apps permission table or
// OpenAPI resource IDs. When a resource exists in the Apps permission table,
// attach its API docs through STRIPE_ADDITIONAL_API_DOC_ENDPOINT_URLS_BY_RESOURCE
// so the generated permission name stays identical to Stripe's published name.
// Otherwise derive the permission stem from a required official object value,
// for example "v2.core.account" -> "v2_core_account".
export const STRIPE_SUPPLEMENTAL_PERMISSION_SOURCES = [
  {
    url: "https://docs.stripe.com/payments/vault-and-forward.md",
    product: "Payments",
    resource: "Forwarding Requests",
    permissions: ["forwarding_request_read", "forwarding_request_write"],
    apiDocUrls: ["https://docs.stripe.com/api/forwarding/request.md"],
    requiredSnippets: [
      "`forwarding_request_write`",
      "`forwarding_request_read`",
      "/v1/forwarding/requests",
    ],
  },
  {
    url: "https://docs.stripe.com/api/v2/core/accounts/object.md",
    product: "Core",
    resource: "Accounts v2",
    permissions: ["v2_core_account_read", "v2_core_account_write"],
    apiDocUrls: ["https://docs.stripe.com/api/v2/core/accounts.md"],
    requiredSnippets: ['"object": "v2.core.account"'],
  },
  {
    url: "https://docs.stripe.com/api/v2/core/persons/object.md",
    product: "Core",
    resource: "Persons v2",
    permissions: [
      "v2_core_account_person_read",
      "v2_core_account_person_write",
    ],
    apiDocUrls: ["https://docs.stripe.com/api/v2/core/persons.md"],
    requiredSnippets: ['"object": "v2.core.account_person"'],
  },
  {
    url: "https://docs.stripe.com/api/v2/core/person-tokens/object.md",
    product: "Core",
    resource: "Person Tokens v2",
    permissions: [
      "v2_core_account_person_token_read",
      "v2_core_account_person_token_write",
    ],
    apiDocUrls: ["https://docs.stripe.com/api/v2/core/person-tokens.md"],
    requiredSnippets: ['"object": "v2.core.account_person_token"'],
  },
  {
    url: "https://docs.stripe.com/api/v2/core/account-tokens/object.md",
    product: "Core",
    resource: "Account Tokens v2",
    permissions: ["v2_core_account_token_read", "v2_core_account_token_write"],
    apiDocUrls: ["https://docs.stripe.com/api/v2/core/account-tokens.md"],
    requiredSnippets: ['"object": "v2.core.account_token"'],
  },
  {
    url: "https://docs.stripe.com/api/v2/core/event-destinations/object.md",
    product: "Webhook Endpoints",
    resource: "Webhook Endpoints, Event Destinations",
    permissions: ["webhook_write"],
    apiDocUrls: ["https://docs.stripe.com/api/v2/core/events.md"],
    requiredSnippets: ['"object": "v2.core.event_destination"'],
  },
  {
    url: "https://docs.stripe.com/api/v2/billing/meter-event-adjustments/object.md",
    product: "Billing",
    resource: "Meter Event Adjustments v2",
    permissions: ["v2_billing_meter_event_adjustment_write"],
    apiDocUrls: [
      "https://docs.stripe.com/api/v2/billing/meter-event-adjustments.md",
    ],
    requiredSnippets: ['"object": "v2.billing.meter_event_adjustment"'],
  },
  {
    url: "https://docs.stripe.com/api/v2/meter-event-streams/meter-event-sessions/object.md",
    product: "Billing",
    resource: "Meter Event Sessions v2",
    permissions: ["v2_billing_meter_event_session_write"],
    apiDocUrls: [
      "https://docs.stripe.com/api/v2/meter-event-streams/meter-event-sessions/create.md",
    ],
    requiredSnippets: ['"object": "v2.billing.meter_event_session"'],
  },
] as const;

const STRIPE_SKIPPED_API_DOC_ENDPOINT_URLS = new Set([
  // The permission controls expanding the `source` attribute; it is not a
  // general balance transaction read permission.
  "https://docs.stripe.com/api/balance_transactions.md",
  // This linked permission page currently has no markdown endpoint-list page.
  "https://docs.stripe.com/api/capital/financing_transactions.md",
  // The permission row is for usage records, but the linked API page contains
  // subscription item CRUD endpoints.
  "https://docs.stripe.com/api/subscription_items.md",
]);

const STRIPE_ADDITIONAL_API_DOC_ENDPOINT_URLS_BY_RESOURCE = new Map<
  string,
  string[]
>([
  ["Account Links", ["https://docs.stripe.com/api/v2/core/account-links.md"]],
  [
    "Billing Meter Events",
    [
      "https://docs.stripe.com/api/v2/meter-events.md",
      "https://docs.stripe.com/api/v2/billing/meter-event-sessions/create-async.md",
    ],
  ],
  ["Events", ["https://docs.stripe.com/api/v2/core/events.md"]],
  [
    "Product Catalog Imports",
    ["https://docs.stripe.com/api/v2/commerce/product-catalog-imports.md"],
  ],
  [
    "Sources",
    [
      // Stripe exposes one Sources permission for the legacy customer source
      // family; the card and customer bank account API pages list additional
      // customer source endpoints that the Sources page links to by guide only.
      "https://docs.stripe.com/api/cards.md",
      "https://docs.stripe.com/api/customer_bank_accounts.md",
    ],
  ],
  [
    "Webhook Endpoints, Event Destinations",
    ["https://docs.stripe.com/api/v2/core/event-destinations.md"],
  ],
]);

function stripeDocsMarkdownUrl(url: string): string | null {
  const parsedUrl = new URL(url);
  if (
    parsedUrl.origin !== "https://docs.stripe.com" ||
    !parsedUrl.pathname.startsWith("/api/")
  ) {
    return null;
  }
  if (!parsedUrl.pathname.endsWith(".md")) {
    parsedUrl.pathname = `${parsedUrl.pathname}.md`;
  }
  return parsedUrl.toString();
}

export function stripeApiDocUrlsFromDescription(description: string): string[] {
  const urls = new Set<string>();
  for (const match of description.matchAll(/<Link>[^|]+\|([^<]+)<\/Link>/g)) {
    const url = stripeDocsMarkdownUrl(match[1]!);
    if (url && !STRIPE_SKIPPED_API_DOC_ENDPOINT_URLS.has(url)) {
      urls.add(url);
    }
  }
  return [...urls].sort();
}

export function stripeAdditionalApiDocUrlsForResource(
  resource: string,
): string[] {
  return (
    STRIPE_ADDITIONAL_API_DOC_ENDPOINT_URLS_BY_RESOURCE.get(resource) ?? []
  );
}
