// Forward first-touch acquisition attribution from www.vm0.ai into the app.
//
// www.vm0.ai and app.vm0.ai are different origins but share the vm0.ai
// registrable domain, so a first-party cookie scoped to `.vm0.ai` is readable
// on both — the standard way to share attribution across subdomains (this is
// how the Clerk session already crosses the hop). The marketing site computes
// first-touch attribution and writes the cookie (consent-gated); the app reads
// it on first load. No link decoration / DOM mutation is involved.

import {
  ACQUISITION_ATTRIBUTION_COOKIE,
  type SourceType,
} from "@vm0/api-contracts/contracts/zero-attribution";

// Inbound ad params forwarded verbatim into the cookie. Mirrors the app capture
// layer (apps/platform ad-attribution.ts).
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

const ATTRIBUTION_SOURCE_PARAM = "vm0_source";
const HOMEPAGE_ATTRIBUTION_VALUE = "homepage";
const VM0_ROOT_DOMAIN = "vm0.ai";

const AD_TRAFFIC_MARKERS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_campaign",
] as const;

// 90 days: covers the signup -> paid funnel, and is the standard ad
// click-attribution window. First-touch, so it is never extended on revisit.
const COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

const PAID_MEDIUMS = new Set([
  "cpc",
  "ppc",
  "paid",
  "paid_search",
  "paid-social",
  "paid_social",
  "display",
]);

const ORGANIC_SEARCH_DOMAINS = [
  "baidu.com",
  "bing.com",
  "duckduckgo.com",
  "ecosia.org",
  "google.com",
  "google.co",
  "naver.com",
  "search.yahoo.com",
  "yahoo.com",
  "yandex.com",
] as const;

const ORGANIC_SEARCH_MEDIUMS = new Set(["organic", "organic_search", "seo"]);

interface LandingAttributionContext {
  readonly referrer?: string;
  readonly hostname?: string;
  readonly pathname?: string;
}

function normalizeDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function rootDomainOf(hostname: string): string {
  const normalized = normalizeDomain(hostname);
  return normalized === VM0_ROOT_DOMAIN ||
    normalized.endsWith(`.${VM0_ROOT_DOMAIN}`)
    ? VM0_ROOT_DOMAIN
    : normalized;
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = normalizeDomain(hostname);
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

function isOrganicSearchDomain(hostname: string): boolean {
  const normalized = normalizeDomain(hostname);
  return (
    normalized.startsWith("google.") ||
    normalized.endsWith(".google.com") ||
    ORGANIC_SEARCH_DOMAINS.some((domain) => {
      return domainMatches(normalized, domain);
    })
  );
}

function referrerDomain(referrer: string | undefined): string | undefined {
  if (!referrer) {
    return undefined;
  }
  try {
    return normalizeDomain(new URL(referrer).hostname);
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function sourceType(
  params: URLSearchParams,
  referrerHostname: string | undefined,
): SourceType {
  const medium = params.get("utm_medium")?.toLowerCase();
  if (
    params.has("gclid") ||
    params.has("gbraid") ||
    params.has("wbraid") ||
    (medium ? PAID_MEDIUMS.has(medium) : false)
  ) {
    return "paid";
  }

  if (medium && ORGANIC_SEARCH_MEDIUMS.has(medium)) {
    return "organic_search";
  }

  if (
    params.has("utm_source") ||
    params.has("utm_medium") ||
    params.has("utm_campaign")
  ) {
    return "referral";
  }

  if (!referrerHostname) {
    return "direct";
  }

  if (rootDomainOf(referrerHostname) === VM0_ROOT_DOMAIN) {
    return "internal";
  }

  if (isOrganicSearchDomain(referrerHostname)) {
    return "organic_search";
  }

  return "referral";
}

// Pure builder: derive the attribution param set from the landing URL + page
// context. No DOM / storage access, so it is unit-testable in isolation.
function acquisitionAttributionParams(
  landingSearch: string,
  context: LandingAttributionContext = {},
): URLSearchParams {
  const sourceParams = new URLSearchParams(landingSearch);
  const attribution = new URLSearchParams();
  const referrerHostname = referrerDomain(context.referrer);

  attribution.set(ATTRIBUTION_SOURCE_PARAM, HOMEPAGE_ATTRIBUTION_VALUE);
  attribution.set("source_type", sourceType(sourceParams, referrerHostname));
  if (referrerHostname) {
    attribution.set("referrer_domain", truncate(referrerHostname, 253));
  }
  if (context.hostname) {
    attribution.set(
      "landing_host",
      truncate(normalizeDomain(context.hostname), 253),
    );
  }
  if (context.pathname) {
    attribution.set("landing_path", truncate(context.pathname, 500));
  }

  for (const param of AD_ATTRIBUTION_PARAMS) {
    for (const value of sourceParams.getAll(param)) {
      attribution.append(param, value);
    }
  }

  return attribution;
}

export function currentLandingAttributionContext(): LandingAttributionContext {
  if (typeof window === "undefined") {
    return {};
  }

  return {
    referrer: document.referrer,
    hostname: window.location.hostname,
    pathname: window.location.pathname,
  };
}

function hasAdTraffic(params: URLSearchParams): boolean {
  return AD_TRAFFIC_MARKERS.some((param) => {
    return params.has(param);
  });
}

function appendHomepageAttributionParams(
  url: URLSearchParams,
  landingSearch: string,
): void {
  const landingParams = new URLSearchParams(landingSearch);
  url.set(ATTRIBUTION_SOURCE_PARAM, HOMEPAGE_ATTRIBUTION_VALUE);
  for (const param of AD_ATTRIBUTION_PARAMS) {
    for (const value of landingParams.getAll(param)) {
      url.append(param, value);
    }
  }
}

// Build the signed-out homepage CTA href. Keep users on the normal web
// /sign-up flow, but decorate ad/campaign visits so the sign-up page can carry
// the same attribution into Clerk's final app redirect.
export function buildSignupHref(landingSearch: string): string {
  const params = new URLSearchParams(landingSearch);
  if (!hasAdTraffic(params)) {
    return "/sign-up";
  }

  const signupParams = new URLSearchParams();
  appendHomepageAttributionParams(signupParams, landingSearch);
  return `/sign-up?${signupParams.toString()}`;
}

export function buildSignupRedirectUrl(
  appUrl: string,
  signUpSearch: string,
): string {
  const params = new URLSearchParams(signUpSearch);
  if (!hasAdTraffic(params)) {
    return appUrl;
  }

  const url = new URL("/onboarding", appUrl);
  appendHomepageAttributionParams(url.searchParams, signUpSearch);
  return url.toString();
}

// Cookie I/O is isolated behind this interface so the write path is testable
// without a DOM (apps/web tests run in the node environment).
interface CookieJar {
  get(): string;
  set(value: string): void;
}

function documentCookieJar(): CookieJar {
  return {
    get: () => {
      return document.cookie;
    },
    set: (value: string) => {
      document.cookie = value;
    },
  };
}

function readAttributionCookie(cookieString: string): string | null {
  for (const part of cookieString.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq);
    if (key === ACQUISITION_ATTRIBUTION_COOKIE) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return null;
}

// `.vm0.ai` so app.vm0.ai can read it. On non-vm0.ai hosts (local dev, preview)
// fall back to a host-only cookie rather than a domain the browser rejects.
function cookieDomainFor(hostname: string | undefined): string | undefined {
  const host =
    hostname ??
    (typeof window === "undefined" ? undefined : window.location.hostname);
  if (!host) {
    return undefined;
  }
  return rootDomainOf(host) === VM0_ROOT_DOMAIN
    ? `.${VM0_ROOT_DOMAIN}`
    : undefined;
}

// Write first-touch acquisition attribution to the shared `.vm0.ai` cookie.
// First-touch: an existing cookie is never overwritten. Callers MUST gate this
// on marketing/advertising consent. Returns whether a cookie was written.
export function writeAcquisitionAttributionCookie(
  context: LandingAttributionContext = {},
  landingSearch = "",
  jar: CookieJar = documentCookieJar(),
): boolean {
  if (readAttributionCookie(jar.get()) !== null) {
    return false;
  }

  const value = acquisitionAttributionParams(landingSearch, context).toString();
  if (!value) {
    return false;
  }

  const segments = [
    `${ACQUISITION_ATTRIBUTION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    "Secure",
  ];
  const domain = cookieDomainFor(context.hostname);
  if (domain) {
    segments.push(`Domain=${domain}`);
  }
  jar.set(segments.join("; "));
  return true;
}
