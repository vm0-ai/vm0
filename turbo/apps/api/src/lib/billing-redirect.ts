import { env } from "./env";

// Billing redirect URLs (Stripe checkout success/cancel and billing-portal
// return URLs) are client-supplied and flow straight to Stripe, and the success
// URL carries the checkout session id. To prevent an open redirect / session-id
// leak we pin the target to vm0-owned hosts:
//   - the configured app origin (APP_URL) — also covers dev/test localhost,
//   - any first-party *.vm0.ai production domain (app.vm0.ai, so.vm0.ai, ...),
//   - *.vm6.ai staging and per-branch preview hosts.
// User-hosted content lives on a different registrable domain (sites.vm0.io),
// so the *.vm0.ai wildcard stays first-party. hostname comes from URL parsing,
// so the suffix checks cannot be spoofed by paths or userinfo.
export function billingRedirectAllowed(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  if (url.origin === new URL(env("APP_URL")).origin) {
    return true;
  }
  const host = url.hostname;
  return (
    host === "vm0.ai" || host.endsWith(".vm0.ai") || host.endsWith(".vm6.ai")
  );
}
