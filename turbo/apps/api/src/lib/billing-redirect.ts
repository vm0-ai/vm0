import { env } from "./env";
import { isOkouAppWorkerPreviewHostname } from "./cors";

// Billing redirect URLs (Stripe checkout success/cancel and billing-portal
// return URLs) are client-supplied and flow straight to Stripe, and the success
// URL carries the checkout session id. To prevent an open redirect / session-id
// leak we pin the target to Okou-owned hosts:
//   - the configured app origin (APP_URL) — also covers dev/test localhost,
//   - okou.ai and its production subdomains,
//   - *.omby.ai staging and per-branch preview hosts.
// Preview APIs also accept exact standalone app Worker preview hosts used by
// E2E. Production APIs do not, so checkout session ids cannot be redirected to
// preview code.
// User-hosted content lives on different registrable domains (sites.vm0.io,
// okou.app), so the *.okou.ai wildcard stays first-party. hostname comes from URL parsing,
// so the suffix checks cannot be spoofed by paths or userinfo.
export function billingRedirectAllowed(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  if (url.origin === new URL(env("APP_URL")).origin) {
    return true;
  }
  const host = url.hostname;
  return (
    host === "okou.ai" ||
    host.endsWith(".okou.ai") ||
    host.endsWith(".omby.ai") ||
    (env("ENV") === "preview" &&
      url.port === "" &&
      isOkouAppWorkerPreviewHostname(host))
  );
}
