// Forward inbound ad attribution from the www.vm0.ai marketing pages into the
// app, so paid campaigns that land on the homepage (e.g. the "Ha"/"Hb" Google
// Ads campaigns hitting https://www.vm0.ai/?gclid=...&utm_campaign=ha) keep
// their attribution all the way into Clerk private_metadata + Stripe checkout
// metadata.
//
// The app's capture layer (apps/platform recordAdAttribution) is entirely
// driven by the inbound URL query, so the only thing missing is forwarding the
// params onto the CTA href. The so.vm0.ai landing pages already do this via
// buildPresentationRemixHref; this is the homepage equivalent.

// Params forwarded verbatim. Mirrors apps/platform ad-attribution.ts and the
// presentation LP helper so the same keys flow through end to end.
const AD_ATTRIBUTION_PARAMS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;

// Presence of any of these marks the visit as paid/campaign traffic. We only
// reroute + stamp those visits, leaving the organic homepage /sign-up flow
// untouched.
const AD_TRAFFIC_MARKERS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_campaign",
] as const;

const ATTRIBUTION_SOURCE_PARAM = "vm0_source";
const HOMEPAGE_ATTRIBUTION_VALUE = "homepage";

// Build the signed-out CTA href.
// - Organic visits (no ad params): return the existing relative "/sign-up" so
//   the homepage flow is unchanged.
// - Ad/campaign visits: route straight to the app's /onboarding with the ad
//   params forwarded (and vm0_source=homepage), matching how the so.vm0.ai
//   landing pages work. Going direct to the app means recordAdAttribution fires
//   on first app load and stores the params before sign-up, instead of relying
//   on them surviving the Clerk redirect.
export function buildSignupHref(appUrl: string, landingSearch: string): string {
  const params = new URLSearchParams(landingSearch);
  const isAdTraffic = AD_TRAFFIC_MARKERS.some((param) => {
    return params.has(param);
  });
  if (!isAdTraffic) {
    return "/sign-up";
  }

  const url = new URL("/onboarding", appUrl);
  url.searchParams.set(ATTRIBUTION_SOURCE_PARAM, HOMEPAGE_ATTRIBUTION_VALUE);
  for (const param of AD_ATTRIBUTION_PARAMS) {
    for (const value of params.getAll(param)) {
      url.searchParams.append(param, value);
    }
  }

  return url.toString();
}
