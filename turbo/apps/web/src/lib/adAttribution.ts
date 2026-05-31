// Forward acquisition attribution from www.vm0.ai into the app. The app's
// capture layer is URL-query driven, then stores in app sessionStorage before
// recording to Clerk/Stripe, so marketing surfaces must carry the source facts
// across the domain hop.

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
const STORED_ACQUISITION_ATTRIBUTION_KEY = "vm0.acquisitionAttribution";
const VM0_ROOT_DOMAIN = "vm0.ai";

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

export interface LandingAttributionContext {
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
): "paid" | "organic_search" | "referral" | "direct" | "internal" | "unknown" {
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

  if (params.has("utm_source") || params.has("utm_campaign")) {
    return "referral";
  }

  return "referral";
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage;
}

function acquisitionAttributionParams(
  landingSearch: string,
  context: LandingAttributionContext = {},
): URLSearchParams {
  const sourceParams = new URLSearchParams(landingSearch);
  const attribution = new URLSearchParams();
  const referrerHostname = referrerDomain(context.referrer);

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

function storedAcquisitionAttributionParams(
  landingSearch: string,
  context: LandingAttributionContext = {},
  storage: Storage | null = getSessionStorage(),
): URLSearchParams {
  const attribution = acquisitionAttributionParams(landingSearch, context);
  if (!storage) {
    return attribution;
  }

  const stored = storage.getItem(STORED_ACQUISITION_ATTRIBUTION_KEY);
  if (stored) {
    return new URLSearchParams(stored);
  }

  const serialized = attribution.toString();
  if (serialized) {
    storage.setItem(STORED_ACQUISITION_ATTRIBUTION_KEY, serialized);
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

function applyAcquisitionAttribution(
  url: URL,
  landingSearch: string,
  context?: LandingAttributionContext,
): void {
  url.searchParams.set(ATTRIBUTION_SOURCE_PARAM, HOMEPAGE_ATTRIBUTION_VALUE);
  const attribution = storedAcquisitionAttributionParams(
    landingSearch,
    context,
  );
  for (const [key, value] of attribution) {
    if (!url.searchParams.has(key)) {
      url.searchParams.append(key, value);
    }
  }
}

export function buildSignupHref(
  appUrl: string,
  landingSearch: string,
  context?: LandingAttributionContext,
): string {
  const url = new URL("/onboarding", appUrl);
  applyAcquisitionAttribution(url, landingSearch, context);
  return url.toString();
}

export function decorateAttributionHref(
  href: string,
  appUrl: string,
  landingSearch: string,
  context?: LandingAttributionContext,
): string {
  const currentOrigin =
    context?.hostname === undefined
      ? "https://www.vm0.ai"
      : `https://${context.hostname}`;
  let url: URL;
  let app: URL;
  try {
    url = new URL(href, currentOrigin);
    app = new URL(appUrl);
  } catch {
    return href;
  }

  if (url.hostname === app.hostname && url.pathname === "/onboarding") {
    applyAcquisitionAttribution(url, landingSearch, context);
    return url.toString();
  }

  if (
    rootDomainOf(url.hostname) === VM0_ROOT_DOMAIN &&
    url.pathname === "/sign-up"
  ) {
    const onboardingUrl = new URL("/onboarding", appUrl);
    for (const [key, value] of url.searchParams) {
      onboardingUrl.searchParams.append(key, value);
    }
    applyAcquisitionAttribution(onboardingUrl, landingSearch, context);
    return onboardingUrl.toString();
  }

  return href;
}
