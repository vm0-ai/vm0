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

function stripeDocsMarkdownUrl(url: string): string | null {
  if (!url.startsWith("https://docs.stripe.com/api/")) return null;
  return url.endsWith(".md") ? url : `${url}.md`;
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
