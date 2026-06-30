import { command, computed, state } from "ccstate";
import { clearSentryUser, setSentryUser } from "../lib/sentry.ts";
import { clearPostHogUser, setPostHogUser } from "../lib/posthog.ts";
import { bestEffort, onDomEventFn } from "./utils.ts";

const reload$ = state(0);
const clerkVersion$ = state(0);

const ATTRIBUTION_SOURCE_PARAM = "vm0_source";
const HOMEPAGE_ATTRIBUTION_VALUE = "homepage";
const VM0_ONBOARDING_PATH = "/onboarding/491858";
const VM0_ONBOARDING_EXPERIMENT = "491858";
const DEFAULT_ONBOARDING_URL = "https://www.vm0.ai";
const VM0_ROOT_DOMAIN = "vm0.ai";
const LOCAL_VM7_SO_HOSTNAME = "so.vm7.ai";
const LOCAL_VM7_API_HOSTNAME = "api.vm7.ai";
const LOCAL_VM7_SERVICE_PORT = "8443";
const LOCAL_VM7_MARKETING_DEV_PORT = "8441";

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

const AD_TRAFFIC_MARKERS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_campaign",
] as const;

/**
 * Resolve the hosted auth/onboarding origin.
 * Prefer the configured onboarding origin; the app/platform -> www derivation
 * remains a fallback for older environments.
 */
export function resolveWebOrigin(): string {
  const configuredUrl = import.meta.env.VITE_ONBOARDING_URL as
    | string
    | undefined;
  if (configuredUrl) {
    return new URL(configuredUrl).origin;
  }

  const origin = location.origin;
  if (!origin || origin === "null") {
    return "";
  }
  const url = new URL(origin);
  url.hostname = url.hostname.replace(/(^|-)(platform|app)\./, "$1www.");
  return url.origin;
}

export function resolveAppOrigin(): string {
  const origin = location.origin;
  return !origin || origin === "null" ? "" : origin;
}

function hasVm6Suffix(hostname: string): boolean {
  return hostname === "vm6.ai" || hostname.endsWith(".vm6.ai");
}

function parseUrl(value: string): URL | null {
  if (!URL.canParse(value)) {
    return null;
  }
  return new URL(value);
}

function parseDomainOverrideUrl(value: string): URL | null {
  return parseUrl(value.includes("://") ? value : `https://${value}`);
}

function getVm6OriginFromDomainParam(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const url = parseDomainOverrideUrl(trimmed);
  if (!url) {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !hasVm6Suffix(url.hostname)
  ) {
    return null;
  }

  return url.origin;
}

function getLocalVm7OriginFromDomainParam(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const url = parseDomainOverrideUrl(trimmed);
  if (!url) {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname !== LOCAL_VM7_API_HOSTNAME ||
    url.port !== LOCAL_VM7_SERVICE_PORT ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  return url.origin;
}

function getDomainOverrideHostFromSearch(): string | null {
  const domainParam = new URLSearchParams(location.search).get("domain");
  const vm6Origin = getVm6OriginFromDomainParam(domainParam);
  if (vm6Origin) {
    return new URL(vm6Origin).host;
  }

  const localVm7Origin = getLocalVm7OriginFromDomainParam(domainParam);
  return localVm7Origin ? new URL(localVm7Origin).host : null;
}

function replaceVm0ServiceLabel(
  hostname: string,
  service: "api" | "app" | "www",
): string | null {
  const labels = hostname.split(".");
  const firstLabel = labels[0];
  if (!firstLabel) {
    return null;
  }

  if (
    firstLabel === "api" ||
    firstLabel === "app" ||
    firstLabel === "so" ||
    firstLabel === "www"
  ) {
    labels[0] = service;
    return labels.join(".");
  }

  for (const label of ["api", "app", "so", "www"]) {
    const suffix = `-${label}`;
    if (firstLabel.endsWith(suffix)) {
      labels[0] = `${firstLabel.slice(0, -label.length)}${service}`;
      return labels.join(".");
    }
  }

  return null;
}

function resolveDomainOverride(): string | null {
  if (import.meta.env.VITE_VERCEL_ENV !== "production") {
    const configuredDomain = import.meta.env.VITE_ONBOARDING_DOMAIN as
      | string
      | undefined;
    if (configuredDomain) {
      return configuredDomain;
    }
  }

  const origin = location.origin;
  if (!origin || origin === "null") {
    return null;
  }
  const url = new URL(origin);
  if (!url.hostname.endsWith(".vm6.ai")) {
    return null;
  }
  const apiHostname = url.hostname.replace(
    /(^|-)(platform|app|www)\./,
    "$1api.",
  );
  return apiHostname === url.hostname ? null : apiHostname;
}

function resolveUrlFromDomainOverride(
  service: "api" | "app" | "www",
): string | null {
  const domainOverride = getDomainOverrideHostFromSearch();
  if (!domainOverride) {
    return null;
  }

  const hostname = replaceVm0ServiceLabel(domainOverride, service);
  return hostname ? `https://${hostname}` : null;
}

export function resolveAppUrlFromDomainOverride(): string | null {
  return resolveUrlFromDomainOverride("app");
}

function resolveApiUrlFromDomainOverride(): string | null {
  const domainOverride = getDomainOverrideHostFromSearch();
  return domainOverride ? `https://${domainOverride}` : null;
}

function resolveWebUrlFromDomainOverride(): string | null {
  return resolveUrlFromDomainOverride("www");
}

export function resolveAppUrl(): string {
  return resolveAppUrlFromDomainOverride() ?? resolveAppOrigin();
}

export function resolveWebAuthUrl(
  path: `/sign-${string}`,
  options: { redirectUrl?: string } = {},
): string {
  const webOrigin = resolveWebOrigin();
  if (!webOrigin) {
    return path;
  }
  const url = new URL(path, webOrigin);
  const domainOverride = resolveDomainOverride();
  if (domainOverride) {
    url.searchParams.set("domain", domainOverride);
  }
  if (options.redirectUrl) {
    url.searchParams.set("redirect_url", options.redirectUrl);
  }
  return url.toString();
}

export function resolveAppAuthUrl(
  path: `/sign-${string}`,
  options: { redirectUrl?: string } = {},
): string {
  const appOrigin = resolveAppOrigin();
  if (!appOrigin) {
    return path;
  }
  const url = new URL(path, appOrigin);
  const domainOverride = resolveDomainOverride();
  if (domainOverride) {
    url.searchParams.set("domain", domainOverride);
  }
  if (options.redirectUrl) {
    url.searchParams.set("redirect_url", options.redirectUrl);
  }
  return url.toString();
}

function paidOnboardingUrl(): string | undefined {
  const configuredUrl = import.meta.env.VITE_ONBOARDING_URL as
    | string
    | undefined;
  return configuredUrl || undefined;
}

function isVm6Origin(origin: string): boolean {
  const url = parseUrl(origin);
  if (!url) {
    return false;
  }
  return url.hostname.endsWith(".vm6.ai");
}

export function getAllowedAuthRedirectOrigins(): string[] {
  const appUrl = resolveAppUrl();
  const onboardingUrl = paidOnboardingUrl();
  const origins = onboardingUrl ? [appUrl, onboardingUrl] : [appUrl];

  if (origins.some(isVm6Origin)) {
    origins.push("https://*.vm6.ai");
  }

  return [...new Set(origins.filter(Boolean))];
}

export function getAllowedAuthRedirectOriginsFromDomainOverride(): string[] {
  if (!getDomainOverrideHostFromSearch()) {
    return [];
  }

  const origins = [
    resolveWebUrlFromDomainOverride(),
    resolveApiUrlFromDomainOverride(),
    resolveAppUrlFromDomainOverride(),
    resolveAppOrigin(),
  ];

  return [
    ...new Set(
      origins.filter((origin): origin is string => {
        return Boolean(origin);
      }),
    ),
  ];
}

export function getAllowedAuthRedirectOriginsFromCurrentRedirectUrl(): string[] {
  const rawRedirectUrl = new URLSearchParams(location.search).get(
    "redirect_url",
  );
  if (!rawRedirectUrl) {
    return [];
  }

  const redirectUrl = parseUrl(rawRedirectUrl);
  if (!redirectUrl) {
    return [];
  }

  if (
    redirectUrl.protocol !== "https:" ||
    redirectUrl.hostname !== LOCAL_VM7_SO_HOSTNAME ||
    (redirectUrl.port !== LOCAL_VM7_SERVICE_PORT &&
      redirectUrl.port !== LOCAL_VM7_MARKETING_DEV_PORT) ||
    (redirectUrl.pathname !== "/onboarding" &&
      !redirectUrl.pathname.startsWith("/onboarding/"))
  ) {
    return [];
  }

  return [redirectUrl.origin];
}

export function getAllowedAuthRedirectOriginsForCurrentPage(): string[] {
  return [
    ...new Set([
      ...getAllowedAuthRedirectOrigins(),
      ...getAllowedAuthRedirectOriginsFromDomainOverride(),
      ...getAllowedAuthRedirectOriginsFromCurrentRedirectUrl(),
    ]),
  ];
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

function onboardingBaseUrl(): string {
  return (paidOnboardingUrl() || DEFAULT_ONBOARDING_URL).replace(/\/+$/u, "");
}

function setCurrentLandingContext(params: URLSearchParams): void {
  if (!params.has("landing_host")) {
    params.set("landing_host", location.hostname);
  }
  if (!params.has("landing_path")) {
    params.set("landing_path", location.pathname);
  }
}

function buildVm0OnboardingEntryUrl(paramsInit?: URLSearchParams): string {
  const params = new URLSearchParams(paramsInit);
  if (!params.has("vm0_experiment")) {
    params.set("vm0_experiment", VM0_ONBOARDING_EXPERIMENT);
  }
  setCurrentLandingContext(params);
  const query = params.toString();
  return `${onboardingBaseUrl()}${VM0_ONBOARDING_PATH}${query ? `?${query}` : ""}`;
}

function isKnownStagingSoOnboardingRedirect(redirectUrl: URL): boolean {
  return (
    redirectUrl.protocol === "https:" &&
    (redirectUrl.hostname === "staging-so.vm6.ai" ||
      redirectUrl.hostname.endsWith("-so.vm6.ai")) &&
    (redirectUrl.pathname === "/onboarding" ||
      redirectUrl.pathname.startsWith("/onboarding/"))
  );
}

function isVm0ProductionOrigin(url: URL): boolean {
  return url.hostname === VM0_ROOT_DOMAIN || url.hostname.endsWith(".vm0.ai");
}

function normalizeOnboardingRedirectUrl(
  redirectUrl: URL,
  onboardingUrl: string | undefined,
): URL {
  if (!onboardingUrl || !isKnownStagingSoOnboardingRedirect(redirectUrl)) {
    return redirectUrl;
  }

  const paidUrl = parseUrl(onboardingUrl);
  if (!paidUrl) {
    return redirectUrl;
  }
  if (isVm0ProductionOrigin(paidUrl)) {
    return redirectUrl;
  }

  const normalized = new URL(redirectUrl.toString());
  normalized.protocol = paidUrl.protocol;
  normalized.host = paidUrl.host;
  return normalized;
}

function isAllowedRedirectOrigin(
  redirectUrl: URL,
  allowedRedirectOrigins: readonly string[],
): boolean {
  return allowedRedirectOrigins.some((allowedOrigin) => {
    if (allowedOrigin.startsWith("https://*.")) {
      const suffix = allowedOrigin.slice("https://*.".length);
      return (
        redirectUrl.protocol === "https:" &&
        redirectUrl.hostname.endsWith(`.${suffix}`)
      );
    }

    const url = parseUrl(allowedOrigin);
    if (!url) {
      return false;
    }
    return url.origin === redirectUrl.origin;
  });
}

function readAllowedRedirectUrl(
  params: URLSearchParams,
  allowedRedirectOrigins: readonly string[],
  onboardingUrl: string | undefined,
): string | null {
  const rawRedirectUrl = params.get("redirect_url");
  if (!rawRedirectUrl) {
    return null;
  }

  const rawUrl = parseUrl(rawRedirectUrl);
  if (!rawUrl) {
    return null;
  }
  const redirectUrl = normalizeOnboardingRedirectUrl(rawUrl, onboardingUrl);
  return isAllowedRedirectOrigin(redirectUrl, allowedRedirectOrigins)
    ? redirectUrl.toString()
    : null;
}

export function buildSignupRedirectUrl(
  signUpSearch: string,
  allowedRedirectOrigins: readonly string[] = getAllowedAuthRedirectOriginsForCurrentPage(),
): string {
  const appUrl = resolveAppUrl();
  const params = new URLSearchParams(signUpSearch);
  const onboardingUrl = paidOnboardingUrl();
  const redirectUrl = readAllowedRedirectUrl(
    params,
    allowedRedirectOrigins,
    onboardingUrl,
  );
  if (redirectUrl) {
    return redirectUrl;
  }

  if (!hasAdTraffic(params)) {
    return appUrl;
  }

  const redirectParams = new URLSearchParams();
  appendHomepageAttributionParams(redirectParams, signUpSearch);
  return buildVm0OnboardingEntryUrl(redirectParams);
}

/**
 * Clerk instance signal.
 *
 * Initializes the real Clerk SDK with the publishable key.
 */
export const clerk$ = computed(async () => {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
    | string
    | undefined;

  if (!publishableKey) {
    throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY environment variable");
  }

  // Dynamic import: @clerk/clerk-js is a 2.8MB webpack monolith (53%
  // Web3/Solana/Coinbase code we don't use) that cannot be tree-shaken.
  // Moving it to a separate async chunk avoids blocking initial JS parsing.
  const { Clerk } = await import("@clerk/clerk-js");

  const clerkInstance = new Clerk(publishableKey);
  await clerkInstance.load({
    signInUrl: resolveAppAuthUrl("/sign-in"),
    signUpUrl: resolveAppAuthUrl("/sign-up"),
    afterSignOutUrl: resolveAppAuthUrl("/sign-in"),
  });
  return clerkInstance;
});

/**
 * Command to setup Clerk authentication listeners.
 * This command initializes the Clerk instance and sets up a listener
 * for authentication state changes.
 */
export const setupClerk$ = command(
  async ({ set, get }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    // Set initial Sentry user context
    if (clerk.user) {
      setSentryUser(clerk.user.id);
      setPostHogUser({
        id: clerk.user.id,
        email: clerk.user.primaryEmailAddress?.emailAddress,
        name: clerk.user.fullName ?? undefined,
      });
    }

    // Track the user ID so we only trigger a reload on actual auth state
    // changes (sign-in / sign-out), not on token refreshes which fire the
    // Clerk listener but don't change the user.
    let prevUserId = clerk.user?.id ?? null;
    const unsubscribe = clerk.addListener(() => {
      // Update Sentry user context on auth state change
      if (clerk.user) {
        setSentryUser(clerk.user.id);
        setPostHogUser({
          id: clerk.user.id,
          email: clerk.user.primaryEmailAddress?.emailAddress,
          name: clerk.user.fullName ?? undefined,
        });
      } else {
        clearSentryUser();
        clearPostHogUser();
      }
      // Bump on every clerk event so signals tracking mutable clerk state
      // (e.g. current org's imageUrl after reload()) re-compute and their
      // subscribers re-render.
      set(clerkVersion$, (x) => {
        return x + 1;
      });
      const currentUserId = clerk.user?.id ?? null;
      if (currentUserId !== prevUserId) {
        prevUserId = currentUserId;
        set(reload$, (x) => {
          return x + 1;
        });
      }
    });
    signal.addEventListener("abort", unsubscribe);
  },
);

/**
 * User signal that provides the current authenticated user from Clerk.
 * Returns undefined if no user is authenticated.
 */
const ORG_ID_KEY = "clerk-active-org-id";

function persistOrgId(orgId: string | undefined) {
  if (orgId) {
    sessionStorage.setItem(ORG_ID_KEY, orgId);
  } else {
    sessionStorage.removeItem(ORG_ID_KEY);
  }
}

/**
 * Command that monitors the active Clerk organization and reloads
 * the page when it changes. Persists the active org ID to session storage.
 */
export const watchOrgSwitch$ = command(async ({ get }, signal: AbortSignal) => {
  const clerk = await get(clerk$);
  signal.throwIfAborted();

  let prevOrgId = sessionStorage.getItem(ORG_ID_KEY) ?? undefined;
  const currentOrgId = clerk.organization?.id ?? undefined;
  prevOrgId = currentOrgId;
  persistOrgId(currentOrgId);

  // Listener stays `() => void`: Clerk's `ListenerCallback` signature
  // is not awaited, and returning a promise from it would trip
  // `typescript/no-misused-promises`. `onDomEventFn` detaches the async
  // work, and `bestEffort` keeps reload behavior even when token rotation
  // rejects.
  const unsubscribe = clerk.addListener(
    onDomEventFn(async () => {
      const newOrgId = clerk.organization?.id ?? undefined;
      if (newOrgId === prevOrgId) {
        return;
      }
      prevOrgId = newOrgId;
      persistOrgId(newOrgId);
      // On mobile, Clerk can transiently clear clerk.organization to
      // undefined during a background token refresh before restoring it on
      // the next event. Guard against that by only reloading when the
      // session is landing on a concrete org (org_A→org_B or
      // undefined→org_A). An org disappearing to undefined is treated as a
      // transient state; the listener will fire again with the real org_id.
      if (!newOrgId) {
        return;
      }

      await bestEffort(
        (async () => {
          return await clerk.session?.getToken({ skipCache: true });
        })(),
      );
      location.href = "/";
    }),
  );
  signal.addEventListener("abort", unsubscribe);
});

export const user$ = computed(async (get) => {
  get(reload$);
  const clerk = await get(clerk$);
  return clerk.user ?? undefined;
});

export const currentUserInfo$ = computed(async (get) => {
  get(clerkVersion$);
  const clerk = await get(clerk$);
  const user = clerk.user;
  if (!user) {
    return undefined;
  }
  return {
    id: user.id,
    fullName: user.fullName,
    firstName: user.firstName,
    imageUrl: user.imageUrl,
    primaryEmailAddress: user.primaryEmailAddress
      ? {
          emailAddress: user.primaryEmailAddress.emailAddress,
        }
      : null,
  };
});

/**
 * Snapshot of the Clerk active organization, re-emitted on every clerk
 * event (via clerkVersion$). Read this instead of `clerk.organization.*`
 * directly when you want the UI to react to in-place mutations such as
 * `clerk.organization.reload()` after a logo or name update.
 */
export const currentOrgInfo$ = computed(async (get) => {
  get(clerkVersion$);
  const clerk = await get(clerk$);
  const org = clerk.organization;
  if (!org) {
    return null;
  }
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    imageUrl: org.imageUrl,
    hasImage: org.hasImage,
  };
});

/**
 * Determines whether the current user needs to select an organization
 * before entering the platform.
 *
 * Returns true when ALL of:
 * - No active organization is set in the Clerk session
 * - AND at least one of:
 *   - User belongs to more than 1 organization
 *   - User has pending organization invitations
 *
 */
export const needsOrgSelection$ = computed(async (get) => {
  get(reload$);
  const clerk = await get(clerk$);
  const user = clerk.user;
  if (!user) {
    return false;
  }

  // If an active organization is already set, no selection needed
  if (clerk.organization) {
    return false;
  }

  // No active organization — user must select or create one
  return true;
});
