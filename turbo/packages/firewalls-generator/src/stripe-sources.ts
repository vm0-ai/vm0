export const STRIPE_OPENAPI_URL =
  "https://raw.githubusercontent.com/stripe/openapi/master/latest/openapi.spec3.json";

export const STRIPE_PERMISSIONS_URL =
  "https://docs.stripe.com/stripe-apps/reference/permissions.md";

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
